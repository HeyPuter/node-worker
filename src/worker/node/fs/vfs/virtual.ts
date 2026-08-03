// Host-driven in-memory content.
//
// Everything the page can put into the filesystem without it existing in storage:
// a single injected module (`NodeWorker.registerVirtualModule`), or a whole project
// populated into a memory mount and then executed.
//
// Injected content used to be a `Map<specifier, code>` inside the module resolver,
// consulted before resolution and invisible to everything else — `fs.readFileSync`
// of such a path returned ENOENT, and it could never be a directory, a listing, or
// a stat. It now goes into a real in-memory tree, so an injected file is an ordinary
// file: it stats, it appears in a listing of its parent, and the resolver reaches it
// through the normal path.
//
// A deliberately narrow entry point. `worker/index.ts` imports *this*, not the fs
// barrel — the entry module is where rollup's inject-plugin ordering has bitten
// before (see the note on `apiStatsEnabled` in worker/puter.ts), so the fewer edges
// it has into this subgraph the better.

import nodeBuffer from "../../buffer";
import nodePath from "../../path";
import { normalizePath } from "../util";
import { localAdd, localRemove, localWrite } from "../local-events";
import {
	createMemoryProvider,
	type MemListEntry,
	type MemListOptions,
	type MemoryProvider,
} from "./memory";
import { mount, resolveMount, unmount } from "./mounts";
import { overlayProvider } from "./index";
import {
	invalidateResolved,
	invalidateResolvedSubtree,
} from "../../../module/resolve";

let Buffer = nodeBuffer.Buffer;

/** Memory mounts the host has created, by root. */
let hostMounts = new Map<string, MemoryProvider>();

/**
 * Normalize a mount root to the canonical form the mount table demands: absolute,
 * no trailing slash, no `.`/`..`/`//`.
 */
function normalizeRoot(root: string): string {
	let resolved = normalizePath(root);
	return resolved.length > 1 && resolved.endsWith("/")
		? resolved.slice(0, -1)
		: resolved;
}

/**
 * The provider a host operation targets. "/" is the sparse overlay over the root
 * mount — the same layer injected modules land in — rather than a mount of its own.
 */
function providerFor(root: string): MemoryProvider {
	let normalized = normalizeRoot(root);
	if (normalized === "/") return overlayProvider;
	let provider = hostMounts.get(normalized);
	if (!provider) throw new Error(`no memory mount at ${normalized}`);
	return provider;
}

export function mountMemory(
	root: string,
	opts: { readOnly?: boolean; replace?: boolean } = {}
): void {
	let normalized = normalizeRoot(root);
	if (normalized === "/") {
		throw new Error("/ is already mounted; write to it directly instead");
	}
	if (hostMounts.has(normalized)) {
		if (!opts.replace) throw new Error(`already mounted: ${normalized}`);
		unmountMemory(normalized);
	}
	let provider = createMemoryProvider({
		name: `host:${normalized}`,
		prefix: normalized,
	});
	mount(normalized, provider, { readOnly: opts.readOnly });
	hostMounts.set(normalized, provider);
	// Anything the resolver concluded about this subtree — including "there is
	// nothing here", which it derives from a fully-listed ancestor — predates the
	// mount and is now wrong.
	invalidateResolvedSubtree(normalized);
}

export function unmountMemory(root: string): void {
	let normalized = normalizeRoot(root);
	if (!hostMounts.delete(normalized)) return;
	unmount(normalized);
	invalidateResolvedSubtree(normalized);
}

export interface MemEntry {
	path: string;
	data?: Uint8Array;
	mtimeMs?: number;
}

export type { MemListEntry, MemListOptions };

/**
 * Place entries into a memory mount. Files create their own parent directories; an
 * entry with no `data` creates a directory, which is only needed for an empty one.
 *
 * Returns what was written so a bulk populate can be sanity-checked from the host.
 */
export function writeMemory(
	root: string,
	entries: MemEntry[]
): { written: number; bytes: number } {
	let provider = providerFor(root);
	let base = normalizeRoot(root);
	let bytes = 0;

	for (let entry of entries) {
		// Entry paths are relative to the mount root. Resolving against "/" rather
		// than against `base` keeps a `..` in a hostile or careless path from
		// climbing out of the mount — it can only ever bottom out at the mount root.
		let local = nodePath.resolve("/", entry.path);
		let absolute = base === "/" ? local : base + local;
		// Watch events, because these writes go straight to the provider and so bypass
		// the facade that would otherwise emit them. Without this a host edit is
		// invisible to `fs.watch` inside the runtime — which is to say a dev server
		// never notices the file changed, and HMR never fires.
		let existed = provider.get(local) !== undefined;

		if (entry.data === undefined) {
			provider.mkdirp(local);
			if (!existed) localAdd(absolute, true);
			continue;
		}
		// Copy: the incoming view may be a slice of one big transferred buffer, and
		// the tree must own its bytes rather than pin the whole thing.
		let buf = Buffer.from(entry.data);
		let file = provider.put(local, buf);
		if (entry.mtimeMs !== undefined) file.mtimeMs = entry.mtimeMs;
		bytes += buf.length;

		if (existed) localWrite(absolute);
		else localAdd(absolute);

		invalidateResolved(absolute);
	}

	return { written: entries.length, bytes };
}

/**
 * Read one file out of a memory mount, or undefined if it is absent or a directory.
 *
 * The counterpart to `writeMemory`, and the reason the host can treat a mount as a
 * replica rather than the original: whatever a program wrote in there can be pulled
 * back out. Paths are relative to the mount root and contained by it exactly as in
 * `writeMemory`.
 */
export function readMemory(root: string, path: string): Uint8Array | undefined {
	let provider = providerFor(root);
	let live = provider.get(nodePath.resolve("/", path));
	if (!live) return undefined;
	// A plain Uint8Array over a fresh, exactly-sized ArrayBuffer, rather than the
	// tree's own buffer: the caller transfers this, and transferring is destructive.
	// Handing over a Buffer would also mean handing over whatever ArrayBuffer the
	// Buffer implementation chose to sit it in, which is not ours to detach.
	return new Uint8Array(live);
}

/**
 * Walk a directory in a memory mount, or undefined if it is absent or a file.
 *
 * `since` is what makes a post-run diff cheap: one message back with only the nodes
 * a program actually touched, rather than a listing of every file in `node_modules`.
 */
export function listMemory(
	root: string,
	path: string,
	opts: MemListOptions = {}
): MemListEntry[] | undefined {
	let provider = providerFor(root);
	return provider.list(nodePath.resolve("/", path), opts);
}

export function removeMemory(root: string, paths: string[]): void {
	let provider = providerFor(root);
	let base = normalizeRoot(root);
	for (let path of paths) {
		let local = nodePath.resolve("/", path);
		let absolute = base === "/" ? local : base + local;
		// Directory-ness has to be read before the drop, and only matters to the
		// watcher — `provider.list` returning entries is what makes it a directory.
		let wasDir = provider.list(local) !== undefined;
		if (provider.drop(local)) localRemove(absolute, wasDir);
		invalidateResolved(absolute);
	}
}

// --------------------------------------------------------- injected modules

/**
 * The in-memory layer that actually serves `absPath`, and the path within it.
 *
 * Not always the root overlay. Once a memory mount exists at, say, `/proj`, longest
 * prefix wins and every read under it resolves to *that* mount — so putting the file
 * in the overlay would leave it permanently unreachable, shadowed by the very mount
 * it appears to live in. Writing an injected module next to a populated project is a
 * completely ordinary thing to want, so this follows the mount table rather than
 * assuming.
 */
function memoryTargetFor(absPath: string): {
	provider: MemoryProvider;
	local: string;
} {
	let { mount: owner, local } = resolveMount(absPath);
	if (owner.root === "/") return { provider: overlayProvider, local: absPath };
	let provider = hostMounts.get(owner.root);
	if (!provider) {
		// Some other kind of backend owns this subtree — an archive mount, say. There
		// is no in-memory layer to put the file in, and silently writing it somewhere
		// unreachable would be worse than saying so.
		throw new Error(
			`cannot inject at ${absPath}: ${owner.root} is served by a non-memory mount`
		);
	}
	return { provider, local };
}

export function addVirtualFile(path: string, code: string): void {
	let resolved = normalizePath(path);
	let { provider, local } = memoryTargetFor(resolved);
	provider.put(local, Buffer.from(code, "utf8"));
	// The resolver caches source text and stat results permanently. Injected files
	// are the one thing that can be replaced at a stable path, so the caches have to
	// be told; see `invalidateResolved`.
	invalidateResolved(resolved);
}

export function removeVirtualFile(path: string): void {
	let resolved = normalizePath(path);
	let { provider, local } = memoryTargetFor(resolved);
	provider.drop(local);
	invalidateResolved(resolved);
}
