// An in-memory filesystem.
//
// A real tree — directories, mtimes, listings — not a flat path→bytes map, because
// the things built on it need to be indistinguishable from files: `statSync`,
// `readdirSync` of the parent, and the module resolver's own probing all have to
// work without knowing a path is synthetic.
//
// Every operation returns without yielding, which is what makes this work for the
// sync and async surfaces at once (see ../plan.ts): a plan with no requests in it is
// trivially safe under the blocking driver.
//
// ## The lazy-content seam
//
// `MemFile.content` may be a Buffer *or* a synchronous thunk. That is the hook a
// zip-backed mount hangs on: it builds the tree from the archive's central
// directory alone — name, size, offset — and each file's thunk inflates its own
// entry on demand. Two properties make that viable:
//
//   - `size` comes from the header, so **`stat` never materializes anything**, and
//     the module resolver stats far more paths than it reads;
//   - inflate is synchronous here (the zlib binding is wasm with a real
//     `writeSync`), so a thunk satisfies `readFileSync` without the plan yielding.

import nodeBuffer from "../../buffer";
import nodePath from "../../path";
import type { Plan } from "../plan";
import type { FsProvider, Listing, OpCtx, ReaddirOpts } from "./provider";
import { createFsError, type FsEntry } from "../util";
import {
	localAdd,
	localMove,
	localRemove,
	localWrite,
} from "../local-events";

let Buffer = nodeBuffer.Buffer;

export interface MemFile {
	kind: "file";
	/** Known without materializing `content`. */
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	atimeMs: number;
	content: Buffer | (() => Buffer);
	/**
	 * Detached from its parent but still referenced by an open handle. Reads keep
	 * working, as they do on a real filesystem; a flush must not resurrect it.
	 */
	unlinked?: boolean;
}

export interface MemDir {
	kind: "dir";
	children: Map<string, MemNode>;
	mtimeMs: number;
	ctimeMs: number;
	atimeMs: number;
}

export type MemNode = MemFile | MemDir;

/**
 * One node as reported to an out-of-band walk (`MemoryProvider.list`).
 *
 * Deliberately not `FsEntry`: this serves the host, which wants a path it can key
 * a map by and a size/mtime it can diff, not the uid/symlink/atime fields the fs
 * surface has to carry.
 */
export interface MemListEntry {
	/** Path relative to the provider root, with a leading "/". */
	path: string;
	kind: "file" | "dir";
	/** 0 for directories. */
	size: number;
	mtimeMs: number;
}

export interface MemListOptions {
	/** Descend into subdirectories. Unbounded — the tree is the whole extent. */
	recursive?: boolean;
	/** Report only nodes modified strictly after this time. */
	since?: number;
}

function now(): number {
	return Date.now();
}

export function newDir(): MemDir {
	const t = now();
	return { kind: "dir", children: new Map(), mtimeMs: t, ctimeMs: t, atimeMs: t };
}

export function newFile(content: Buffer | (() => Buffer), size?: number): MemFile {
	const t = now();
	return {
		kind: "file",
		size: size ?? (Buffer.isBuffer(content) ? content.length : 0),
		mtimeMs: t,
		ctimeMs: t,
		atimeMs: t,
		content,
	};
}

/** Materialize a file's bytes, collapsing a thunk on first use. */
function bytesOf(file: MemFile): Buffer {
	if (typeof file.content === "function") {
		const produced = file.content();
		file.content = produced;
		file.size = produced.length;
	}
	return file.content as Buffer;
}

function segments(path: string): string[] {
	return path.split("/").filter((s) => s.length > 0 && s !== ".");
}

export interface MemoryProviderOptions {
	name?: string;
	/**
	 * The absolute path this provider is mounted at, used only to report full paths
	 * in watch events. The provider never consults the mount table — this is a
	 * constant it is handed, not a lookup.
	 */
	prefix?: string;
	/** Seed tree. Defaults to an empty root directory. */
	root?: MemDir;
}

export interface MemoryProvider extends FsProvider {
	/** @internal — the live tree, for seeding and for tests. */
	readonly root: MemDir;
	/** Create or replace a file, making parent directories as needed. */
	put(path: string, content: Buffer | (() => Buffer), size?: number): MemFile;
	/** Create a directory and any missing parents. Existing ones are left alone. */
	mkdirp(path: string): MemDir;
	/** Remove a path if present. Returns whether anything was removed. */
	drop(path: string): boolean;
	/**
	 * @internal — the file's **live** bytes, or undefined if the path is absent or a
	 * directory. Collapses a lazy thunk.
	 *
	 * The imperative counterpart to `put`: no `OpCtx`, no errno, no plan — this is
	 * for the host reading its own mount back, not for the fs surface. Unlike
	 * `readFile` it does not copy, on the same grounds `root` is exposed live: the
	 * only caller is `readMemory`, which has to make a buffer it owns outright
	 * anyway so it can transfer it, and copying here would just mean doing it twice.
	 * Anything else reading this must not mutate or detach what it gets.
	 */
	get(path: string): Buffer | undefined;
	/**
	 * Walk a directory, or undefined if the path is absent or a file.
	 *
	 * The imperative counterpart to `mkdirp`. Unlike `readdir` this can recurse
	 * without a depth cap and can filter by mtime, which is what makes "what
	 * changed since the run started?" answerable in one message over a tree with a
	 * `node_modules` in it.
	 */
	list(path: string, opts?: MemListOptions): MemListEntry[] | undefined;
}

export function createMemoryProvider(
	opts: MemoryProviderOptions = {}
): MemoryProvider {
	const name = opts.name ?? "memory";
	const prefix = opts.prefix ?? "";
	const root: MemDir = opts.root ?? newDir();

	/** The absolute path a local one corresponds to, for watch events. */
	function full(local: string): string {
		if (!prefix) return local;
		return local === "/" ? prefix : prefix + local;
	}

	function fail(
		code: string,
		errno: number,
		message: string,
		ctx: OpCtx
	): never {
		throw createFsError(code, errno, message, ctx.syscall, ctx.reportPath);
	}

	function lookup(path: string): MemNode | undefined {
		let node: MemNode = root;
		for (const seg of segments(path)) {
			if (node.kind !== "dir") return undefined;
			const next = node.children.get(seg);
			if (!next) return undefined;
			node = next;
		}
		return node;
	}

	function mustFind(path: string, ctx: OpCtx): MemNode {
		const node = lookup(path);
		if (!node) fail("ENOENT", -2, "no such file or directory", ctx);
		return node;
	}

	/** The containing directory and final segment, for a mutation. */
	function parentOf(
		path: string,
		ctx: OpCtx
	): { dir: MemDir; name: string } {
		const parts = segments(path);
		if (parts.length === 0) {
			// The mount root itself is not removable or replaceable.
			fail("EPERM", -1, "operation not permitted", ctx);
		}
		const name = parts[parts.length - 1];
		let node: MemNode = root;
		for (const seg of parts.slice(0, -1)) {
			if (node.kind !== "dir") fail("ENOTDIR", -20, "not a directory", ctx);
			const next = node.children.get(seg);
			if (!next) fail("ENOENT", -2, "no such file or directory", ctx);
			node = next;
		}
		if (node.kind !== "dir") fail("ENOTDIR", -20, "not a directory", ctx);
		return { dir: node, name };
	}

	function entryFor(local: string, name: string, node: MemNode): FsEntry {
		return {
			// A *local* path. The facade re-roots it onto the mount before anything
			// above sees it, the same way it does for every provider.
			path: local,
			name,
			uid: "",
			isDir: node.kind === "dir",
			isSymlink: false,
			size: node.kind === "file" ? node.size : 0,
			modifiedMs: node.mtimeMs,
			createdMs: node.ctimeMs,
			accessedMs: node.atimeMs,
		};
	}

	function mkdirp(path: string): MemDir {
		let node: MemDir = root;
		for (const seg of segments(path)) {
			let next = node.children.get(seg);
			if (!next) {
				next = newDir();
				node.children.set(seg, next);
				node.mtimeMs = now();
			}
			if (next.kind !== "dir") {
				throw createFsError("ENOTDIR", -20, "not a directory", "mkdir", path);
			}
			node = next;
		}
		return node;
	}

	/** "/", "" and "/a/" all normalize to the form `walk` concatenates against. */
	function normalizeLocal(path: string): string {
		const parts = segments(path);
		return parts.length === 0 ? "/" : "/" + parts.join("/");
	}

	// The `list` counterpart to `collect`. Kept separate rather than generalized:
	// `collect` answers readdir (FsEntry, capped depth, no filter) and this answers
	// the host (MemListEntry, uncapped, mtime-filtered). Folding them together would
	// mean a function whose every parameter exists for only one of its two callers.
	//
	// `since` filters the output, not the traversal: a directory's mtime does not
	// propagate up from its descendants, so an unmodified ancestor tells you nothing
	// about what changed underneath it and the walk has to be complete regardless.
	// The saving is in the message, not the walk — which is the part that crosses a
	// postMessage boundary.
	function walk(
		dir: MemDir,
		base: string,
		out: MemListEntry[],
		recursive: boolean,
		since?: number
	) {
		for (const [childName, child] of dir.children) {
			const childPath = base === "/" ? `/${childName}` : `${base}/${childName}`;
			if (since === undefined || child.mtimeMs > since) {
				out.push({
					path: childPath,
					kind: child.kind,
					size: child.kind === "file" ? child.size : 0,
					mtimeMs: child.mtimeMs,
				});
			}
			if (recursive && child.kind === "dir") {
				walk(child, childPath, out, recursive, since);
			}
		}
	}

	function collect(
		dir: MemDir,
		base: string,
		out: FsEntry[],
		recursive: boolean,
		depth: number
	) {
		for (const [childName, child] of dir.children) {
			const childPath = base === "/" ? `/${childName}` : `${base}/${childName}`;
			out.push(entryFor(childPath, childName, child));
			if (recursive && child.kind === "dir" && depth > 1) {
				collect(child, childPath, out, recursive, depth - 1);
			}
		}
	}

	const provider: MemoryProvider = {
		name,
		root,

		put(path, content, size) {
			const parts = segments(path);
			const dir = mkdirp("/" + parts.slice(0, -1).join("/"));
			const file = newFile(content, size);
			dir.children.set(parts[parts.length - 1], file);
			dir.mtimeMs = now();
			return file;
		},

		mkdirp,

		drop(path) {
			const parts = segments(path);
			if (parts.length === 0) return false;
			const parent = lookup("/" + parts.slice(0, -1).join("/"));
			if (!parent || parent.kind !== "dir") return false;
			const removed = parent.children.delete(parts[parts.length - 1]);
			if (removed) parent.mtimeMs = now();
			return removed;
		},

		get(path) {
			const node = lookup(path);
			if (!node || node.kind !== "file") return undefined;
			// No atime bump: a host read is out-of-band inspection, not the program
			// touching its own file.
			return bytesOf(node);
		},

		list(path, opts) {
			const node = lookup(path);
			if (!node || node.kind !== "dir") return undefined;
			const out: MemListEntry[] = [];
			walk(node, normalizeLocal(path), out, !!opts?.recursive, opts?.since);
			return out;
		},

		*stat(ctx, path): Plan<FsEntry> {
			const node = mustFind(path, ctx);
			return entryFor(path, nodePath.basename(path) || "/", node);
		},

		*readdir(ctx, path, o?: ReaddirOpts): Plan<Listing> {
			const node = mustFind(path, ctx);
			if (node.kind !== "dir") fail("ENOTDIR", -20, "not a directory", ctx);
			const out: FsEntry[] = [];
			collect(node, path, out, !!o?.recursive, o?.depth ?? Infinity);
			// An in-memory listing is exhaustive by construction — there is no paging
			// and nothing to truncate, so negative inference above is always sound.
			return { entries: out, complete: true };
		},

		// Both reads copy.
		//
		// Handing back the stored buffer would be free, and wrong: `fs.readFileSync`
		// promises a fresh buffer, and callers do mutate what they get — decoders and
		// parsers work in place all the time. Aliasing means such a caller silently
		// rewrites the file it just read, with no write call anywhere. A network
		// backend never has this problem because every read materializes a new buffer
		// from the response, so the hazard is unique to serving bytes out of memory
		// and would only ever show up here.
		//
		// `subarray` is a view, not a copy, so the ranged read needs the same
		// treatment as the whole-file one.
		*readFile(ctx, path): Plan<Buffer> {
			const node = mustFind(path, ctx);
			if (node.kind === "dir") {
				fail("EISDIR", -21, "illegal operation on a directory", ctx);
			}
			node.atimeMs = now();
			return Buffer.from(bytesOf(node));
		},

		*readRange(ctx, path, offset, length): Plan<Buffer> {
			const node = mustFind(path, ctx);
			if (node.kind === "dir") {
				fail("EISDIR", -21, "illegal operation on a directory", ctx);
			}
			return Buffer.from(bytesOf(node).subarray(offset, offset + length));
		},

		*writeFile(ctx, path, data): Plan<void> {
			const { dir, name: base } = parentOf(path, ctx);
			const existing = dir.children.get(base);
			if (existing && existing.kind === "dir") {
				fail("EISDIR", -21, "illegal operation on a directory", ctx);
			}
			const copy = Buffer.from(data);
			if (existing) {
				existing.content = copy;
				existing.size = copy.length;
				existing.mtimeMs = now();
			} else {
				dir.children.set(base, newFile(copy));
				dir.mtimeMs = now();
			}
			// Millisecond resolution, unlike puterfs's one-second timestamps — so a
			// watcher can tell two writes in the same second apart.
			localWrite(full(path));
		},

		*mkdir(ctx, path, o): Plan<string | undefined> {
			if (o.recursive) {
				mkdirp(path);
				localAdd(full(path), true);
				return undefined;
			}
			const { dir, name: base } = parentOf(path, ctx);
			if (dir.children.has(base)) {
				fail("EEXIST", -17, "file already exists", ctx);
			}
			dir.children.set(base, newDir());
			dir.mtimeMs = now();
			localAdd(full(path), true);
			return undefined;
		},

		*rm(ctx, path, o): Plan<void> {
			const parts = segments(path);
			if (parts.length === 0) fail("EPERM", -1, "operation not permitted", ctx);
			const parent = lookup("/" + parts.slice(0, -1).join("/"));
			if (!parent || parent.kind !== "dir") {
				if (o.force) return;
				fail("ENOENT", -2, "no such file or directory", ctx);
			}
			const base = parts[parts.length - 1];
			const node = parent.children.get(base);
			if (!node) {
				if (o.force) return;
				fail("ENOENT", -2, "no such file or directory", ctx);
			}
			if (node.kind === "dir" && node.children.size > 0 && !o.recursive) {
				fail("ENOTEMPTY", -39, "directory not empty", ctx);
			}
			// Detach but leave the node intact: an open handle keeps reading it, and
			// its flush is suppressed rather than resurrecting the file.
			if (node.kind === "file") node.unlinked = true;
			parent.children.delete(base);
			parent.mtimeMs = now();
			localRemove(full(path), node.kind === "dir");
		},

		*rename(ctx, from, to): Plan<void> {
			const src = parentOf(from, ctx);
			const node = src.dir.children.get(src.name);
			if (!node) fail("ENOENT", -2, "no such file or directory", ctx);
			const dst = parentOf(to, ctx);
			src.dir.children.delete(src.name);
			dst.dir.children.set(dst.name, node);
			src.dir.mtimeMs = now();
			dst.dir.mtimeMs = now();
			localMove(full(from), full(to), node.kind === "dir");
		},

		*copyFile(ctx, from, to, o): Plan<void> {
			const node = mustFind(from, ctx);
			if (node.kind === "dir") {
				fail("EISDIR", -21, "illegal operation on a directory", ctx);
			}
			const dst = parentOf(to, ctx);
			if (dst.dir.children.has(dst.name) && !o.overwrite) {
				fail("EEXIST", -17, "file already exists", ctx);
			}
			dst.dir.children.set(dst.name, newFile(Buffer.from(bytesOf(node))));
			dst.dir.mtimeMs = now();
			localAdd(full(to));
		},

		// Real timestamps, exactly as asked — nothing here is limited to "now" the
		// way puterfs's `/touch` is.
		*utimes(ctx, path, atimeMs, mtimeMs): Plan<boolean> {
			const node = mustFind(path, ctx);
			node.atimeMs = atimeMs;
			node.mtimeMs = mtimeMs;
			localWrite(full(path));
			return true;
		},

		// The node itself is the file's identity, so a handle that captured one keeps
		// reading the bytes it opened even after the path is rewritten or unlinked.
		*pin(_ctx, path): Plan<unknown> {
			return lookup(path);
		},
	};

	return provider;
}
