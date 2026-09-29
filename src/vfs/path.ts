// A posix path implementation, and the mount-table string work that goes with it.
//
// The worker gets node's own `path` (src/worker/node/path.ts re-exports it out of the
// node_core tree), but the page and the service worker cannot: `dist/index.js` is
// built with typescript alone and `node-core:` specifiers only resolve inside the
// worker bundle. Since the mount table and every provider need `dirname`/`basename`
// on the host, they need these.
//
// Only what the filesystem layer actually uses is here, and every function is posix —
// there are no drive letters or backslashes in this namespace, so the win/posix split
// node carries is not reproduced.

import { safe } from "../wire/safe";

/** The api clamps a recursive listing's depth to this, and node's readdir has no limit. */
export const MAX_DEPTH = 10;

/**
 * Collapse `.`, `..` and repeated separators.
 *
 * A `..` above an absolute root is dropped rather than kept, which is the
 * containment guarantee the mount layer relies on: `normalize("/tmp/../../etc")` is
 * `/etc`, never `/../etc`, so no path can climb out of the root. A *relative* input
 * keeps its leading `..` segments, as node does.
 */
export function normalize(p: string): string {
	const absolute = safe.stringCharCodeAt(p, 0) === 47; /* "/" */
	const trailing =
		p.length > 1 && safe.stringCharCodeAt(p, p.length - 1) === 47;
	const out: string[] = [];

	const segments = safe.stringSplit(p, "/");
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (out.length > 0 && out[out.length - 1] !== "..") safe.arrayPop(out);
			else if (!absolute) safe.arrayPush(out, "..");
			// An absolute path with nothing left to pop stays at the root.
			continue;
		}
		safe.arrayPush(out, segment);
	}

	let joined = safe.arrayJoin(out, "/");
	if (absolute) joined = "/" + joined;
	if (joined === "") return absolute ? "/" : ".";
	// node keeps a trailing slash on a normalized path, and `resolve` drops it. Only
	// `normalize` preserves it, so callers that need canonical mount roots must go
	// through `resolveFrom` or `checkRoot`.
	if (trailing && joined !== "/") joined += "/";
	return joined;
}

/**
 * `path.resolve`, anchored explicitly.
 *
 * node's `resolve` falls back to `process.cwd()` when its accumulated result isn't
 * absolute; there is no cwd here, so the base is always a parameter. Every caller in
 * this tree passes `"/"`, which is what makes the containment guarantee above
 * unconditional.
 */
export function resolveFrom(base: string, ...parts: string[]): string {
	let acc = base;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!part) continue;
		acc =
			safe.stringCharCodeAt(part, 0) === 47
				? part
				: acc === "/"
					? "/" + part
					: acc + "/" + part;
	}
	const normalized = normalize(acc);
	if (normalized.length > 1 && safe.stringEndsWith(normalized, "/"))
		return safe.stringSlice(normalized, 0, -1);
	return normalized;
}

export function join(...parts: string[]): string {
	const joined = safe.arrayJoin(
		safe.arrayFilter(parts, (p) => p !== ""),
		"/"
	);
	return joined === "" ? "." : normalize(joined);
}

export function dirname(p: string): string {
	if (p === "/" || p === "") return p === "" ? "." : "/";
	// A trailing slash is not a segment: dirname("/a/b/") is "/a", as node has it.
	let end = p.length;
	while (end > 1 && safe.stringCharCodeAt(p, end - 1) === 47) end--;
	const slash = safe.stringLastIndexOf(p, "/", end - 1);
	if (slash === -1) return ".";
	if (slash === 0) return "/";
	return safe.stringSlice(p, 0, slash);
}

export function basename(p: string, ext?: string): string {
	let end = p.length;
	while (end > 1 && safe.stringCharCodeAt(p, end - 1) === 47) end--;
	const slash = safe.stringLastIndexOf(p, "/", end - 1);
	let base = safe.stringSlice(p, slash + 1, end);
	if (base === "/") base = "";
	if (ext && base !== ext && safe.stringEndsWith(base, ext))
		base = safe.stringSlice(base, 0, -ext.length);
	return base;
}

export function extname(p: string): string {
	const base = basename(p);
	const dot = safe.stringLastIndexOf(base, ".");
	// A leading dot is a hidden file, not an extension.
	return dot <= 0 ? "" : safe.stringSlice(base, dot);
}

/** `path.relative`, for a listing that reports paths relative to the directory read. */
export function relative(from: string, to: string): string {
	const a = safe.arrayFilter(
		safe.stringSplit(resolveFrom("/", from), "/"),
		(s) => s !== ""
	);
	const b = safe.arrayFilter(
		safe.stringSplit(resolveFrom("/", to), "/"),
		(s) => s !== ""
	);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const result: string[] = [];
	for (let j = i; j < a.length; j++) safe.arrayPush(result, "..");
	for (let j = i; j < b.length; j++) safe.arrayPush(result, b[j]);
	return safe.arrayJoin(result, "/");
}

// ------------------------------------------------------- the mount-table string work

/**
 * Whether `p` is at or below `root`.
 *
 * The segment-boundary check is load-bearing: a plain `startsWith` makes `/foo-bar` a
 * child of `/foo`. Same trap `relDepth` documents below.
 */
export function under(root: string, p: string): boolean {
	if (root === "/") return true;
	if (!safe.stringStartsWith(p, root)) return false;
	return (
		p.length === root.length || safe.stringCharCodeAt(p, root.length) === 47
	); /* "/" */
}

/** Re-root an absolute path onto its mount, so the provider sees it from "/". */
export function toLocal(root: string, p: string): string {
	if (root === "/") return p;
	const rest = safe.stringSlice(p, root.length);
	return rest === "" ? "/" : rest;
}

/**
 * Mount roots must arrive canonical; this checks rather than fixes.
 *
 * Deliberately hand-rolled string work rather than `resolveFrom`, and kept that way
 * on the move host-side. Mounts used to be registered at *module scope* inside the
 * worker's fs init cycle, where `node/path` might not exist yet — that constraint is
 * gone, but demanding a canonical root still costs internal callers nothing and turns
 * a silently misrouted mount into a loud error.
 */
export function checkRoot(root: string): string {
	if (root === "/") return "/";
	if (
		!safe.stringStartsWith(root, "/") ||
		safe.stringEndsWith(root, "/") ||
		safe.stringIncludes(root, "//") ||
		safe.arrayFilter(
			safe.stringSplit(root, "/"),
			(s) => s === "." || s === ".."
		).length > 0
	) {
		throw new safe.Error(
			`mount root must be absolute and canonical, got ${safe.jsonStringify(root)}`
		);
	}
	return root;
}

/**
 * How many path segments `p` sits below `root`; direct children are 1, and -1 means
 * `p` isn't under `root` at all.
 *
 * The trailing slash on the prefix is load-bearing: without it `/foo-bar` reads as a
 * descendant of `/foo`.
 */
export function relDepth(root: string, p: string): number {
	const prefix = root === "/" ? "/" : root + "/";
	if (!safe.stringStartsWith(p, prefix)) return -1;
	let depth = 1;
	for (let i = prefix.length; i < p.length; i++) {
		if (safe.stringCharCodeAt(p, i) === 47 /* "/" */) depth++;
	}
	return depth;
}
