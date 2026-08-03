// The mount table: which backend serves which subtree.
//
// Deliberately flat — one provider per root, longest matching prefix wins. Layering
// two backends over the same subtree is a *provider* concern (./union.ts), not a
// table concern, which keeps the lookup trivially correct and the layering
// independently testable.
//
// A leaf module: it knows nothing about any concrete provider, so providers can
// depend on the table's types without the table depending on them.

import nodePath from "../../path";
import type { FsProvider } from "./provider";

export interface Mount {
	/** Absolute, normalized, no trailing slash — except "/" itself. */
	readonly root: string;
	readonly provider: FsProvider;
	/** Rejects every mutation with EROFS. */
	readonly readOnly: boolean;
	/** Stands in as the mtime of a synthesized mount-point directory entry. */
	readonly createdMs: number;
}

// Sorted by root length descending, so the first match is the longest one. A
// linear scan over a handful of mounts beats any cleverer structure.
let mounts: Mount[] = [];

/**
 * Whether `p` is at or below `root`.
 *
 * The segment-boundary check is load-bearing: a plain `startsWith` makes
 * `/foo-bar` a child of `/foo`. Same trap `relDepth` documents in
 * ../readdir-recursive.ts.
 */
export function under(root: string, p: string): boolean {
	if (root === "/") return true;
	if (!p.startsWith(root)) return false;
	return p.length === root.length || p.charCodeAt(root.length) === 47; /* "/" */
}

/** Re-root an absolute path onto its mount, so the provider sees it from "/". */
export function toLocal(root: string, p: string): string {
	if (root === "/") return p;
	const rest = p.slice(root.length);
	return rest === "" ? "/" : rest;
}

export interface Resolved {
	readonly mount: Mount;
	/** Mount-relative. The mount point itself is "/". */
	readonly local: string;
	/** The absolute path the caller asked about, for error reporting. */
	readonly full: string;
}

export function resolveMount(path: string): Resolved {
	for (const mount of mounts) {
		if (under(mount.root, path)) {
			return { mount, local: toLocal(mount.root, path), full: path };
		}
	}
	// Unreachable: "/" is mounted at init and matches everything.
	throw new Error(`no mount serves ${path}`);
}

/**
 * Mount roots must arrive canonical; this checks rather than fixes.
 *
 * Deliberately hand-rolled string work instead of `path.resolve`. Mounts are
 * registered at *module scope*, and the fs subgraph evaluates inside a
 * module-init cycle (see ../lazy-base.ts) where `node/path` may not exist yet —
 * calling into it here fails with "Cannot read properties of undefined" before the
 * runtime has finished booting. Callers are all internal and pass literals, so
 * demanding a canonical root costs them nothing.
 */
function checkRoot(root: string): string {
	if (root === "/") return "/";
	if (
		!root.startsWith("/") ||
		root.endsWith("/") ||
		root.includes("//") ||
		root.split("/").some((s) => s === "." || s === "..")
	) {
		throw new Error(
			`mount root must be absolute and canonical, got ${JSON.stringify(root)}`
		);
	}
	return root;
}

export function mount(
	root: string,
	provider: FsProvider,
	opts: { readOnly?: boolean } = {}
): Mount {
	const checked = checkRoot(root);
	if (mounts.some((m) => m.root === checked)) {
		throw new Error(`already mounted: ${checked}`);
	}
	const entry: Mount = {
		root: checked,
		provider,
		readOnly: !!opts.readOnly,
		createdMs: Date.now(),
	};
	mounts.push(entry);
	mounts.sort((a, b) => b.root.length - a.root.length);
	return entry;
}

export function unmount(root: string): boolean {
	const checked = checkRoot(root);
	if (checked === "/") throw new Error("cannot unmount /");
	const before = mounts.length;
	mounts = mounts.filter((m) => m.root !== checked);
	return mounts.length !== before;
}

/** Mounts rooted *directly* beneath `dir` — the ones a listing of `dir` must show. */
export function childMounts(dir: string): Mount[] {
	return mounts.filter(
		(m) => m.root !== "/" && nodePath.dirname(m.root) === dir
	);
}

/** Mounts rooted strictly below `dir`, at any depth — for a recursive listing. */
export function mountsUnder(dir: string): Mount[] {
	return mounts.filter((m) => m.root !== dir && under(dir, m.root));
}

/**
 * Whether `path` is a mount point, or an ancestor of one.
 *
 * The caching layer needs this before it may answer ENOENT from a listing: a
 * directory's children as reported by *one* provider do not include the mounts
 * grafted beneath it, so "absent from the listing" is not "absent from the
 * filesystem" for these paths.
 */
export function isMountPathOrAncestor(path: string): boolean {
	return mounts.some(
		(m) => m.root !== "/" && (m.root === path || under(path, m.root))
	);
}

/** @internal — diagnostics and tests. */
export function listMounts(): readonly Mount[] {
	return mounts;
}
