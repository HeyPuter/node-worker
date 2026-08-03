// The filesystem facade: what everything above this layer calls.
//
// Resolves a path to its mount, delegates, and owns the three things that are about
// the *namespace* rather than any one backend:
//
//   - **Mount grafting.** A listing has to show mounts rooted beneath it, and a
//     recursive listing must not report the real contents of a directory that a
//     mount shadows.
//   - **Cross-mount operations.** No single backend can rename between two of them.
//   - **The optional half of the provider interface.** `readRange` and `copyFile`
//     are fast paths where a backend has one and are derived here where it doesn't,
//     so no caller ever branches on provider capability.
//
// Deliberately NOT here: argument coercion and node's classes, which belong to the
// surface (../sync.ts, ../promises.ts), and anything that reads `CWD`. Every path
// reaching this file is already absolute and normalized.

import { puterProvider } from "./puter";
import { createMemoryProvider } from "./memory";
import { unionProvider } from "./union";
import {
	childMounts,
	mount,
	mountsUnder,
	resolveMount,
	under,
	type Mount,
} from "./mounts";
import type { FsProvider, Listing, OpCtx, ReaddirOpts } from "./provider";
import type { Plan } from "../plan";
import { createFsError, type FsEntry } from "../util";
import nodePath from "../../path";

export { mount, unmount, isMountPathOrAncestor, listMounts } from "./mounts";
export { createMemoryProvider } from "./memory";
export { unionProvider } from "./union";

/**
 * Builds the per-operation context providers need for error reporting. `syscall` is
 * node's name for the operation and shows up in `err.syscall` and the message.
 */
export function ctx(syscall: string, reportPath: string): OpCtx {
	return { syscall, reportPath };
}

// ---------------------------------------------------------------- the mounts

// The root: puterfs with a sparse in-memory layer over it.
//
// The overlay is empty almost always, and a miss is a `Map` lookup that emits no
// request — so the cost of having it is a few nanoseconds per operation and the
// benefit is that a synthesized file can exist at *any* path, indistinguishable
// from a real one. That is what injected modules are now (see ./virtual.ts): real
// files that stat, list and read like everything else, instead of a string the
// module resolver alone knew about and `fs` could not see.
//
// `"existing"` rather than `"upper"`: a write to a path the overlay holds updates
// the overlay, but a write to an ordinary path still goes to ordinary storage.
// Routing every write into memory would silently stop persisting anything.
export const overlayProvider = createMemoryProvider({
	name: "overlay",
	// Mounted at "/", so a local path already is the absolute one.
	prefix: "",
});
mount("/", unionProvider(overlayProvider, puterProvider, "existing"));

// A memory-backed /tmp.
//
// `os.tmpdir()` has always returned "/tmp", but puterfs has no such directory and
// cannot grow one: the root holds user home directories and writing to it is
// refused, so `mkdir("/tmp")` fails and every `mkdtemp`-style caller was pointed at
// an unusable path. An in-memory mount is what that path should have been —
// scratch space that is fast, private, and gone when the worker is.
export const tmpProvider = createMemoryProvider({ name: "tmp", prefix: "/tmp" });
mount("/tmp", tmpProvider);

// ------------------------------------------------------------------ helpers

function providerFor(path: string): FsProvider {
	return resolveMount(path).mount.provider;
}

function assertWritable(m: Mount, c: OpCtx) {
	if (m.readOnly) {
		throw createFsError(
			"EROFS",
			-30,
			"read-only file system",
			c.syscall,
			c.reportPath
		);
	}
}

/** Lift a provider's mount-local entry onto the absolute namespace. */
function reroot(root: string, entry: FsEntry): FsEntry {
	if (root === "/") return entry;
	return { ...entry, path: entry.path === "/" ? root : root + entry.path };
}

/** The directory entry a mount point presents to a listing of its parent. */
function mountPointEntry(m: Mount): FsEntry {
	return {
		path: m.root,
		name: nodePath.basename(m.root),
		uid: "",
		isDir: true,
		isSymlink: false,
		size: 0,
		modifiedMs: m.createdMs,
		createdMs: m.createdMs,
		accessedMs: m.createdMs,
	};
}

// ------------------------------------------------------------------- facade

export const vfs = {
	*stat(c: OpCtx, path: string): Plan<FsEntry> {
		const r = resolveMount(path);
		return reroot(r.mount.root, yield* r.mount.provider.stat(c, r.local));
	},

	*readdir(c: OpCtx, path: string, opts?: ReaddirOpts): Plan<Listing> {
		const r = resolveMount(path);
		const listing = yield* r.mount.provider.readdir(c, r.local, opts);
		let entries = listing.entries.map((e) => reroot(r.mount.root, e));
		let complete = listing.complete;

		if (opts?.recursive) {
			// The provider happily listed the real contents of a directory that a
			// mount shadows. Drop them; the recursion below contributes the mount's
			// own view instead.
			entries = entries.filter((e) => !shadowed(path, e.path));
		}

		// Graft in mounts rooted directly beneath this directory. Never stats them: a
		// stat per mount per listing is a hidden round trip on a hot path, and a
		// caller that wants real numbers stats the path, which resolves *into* the
		// mount and gets the truth.
		for (const m of childMounts(path)) {
			const name = nodePath.basename(m.root);
			const i = entries.findIndex((e) => e.name === name);
			// A mount over a real directory keeps that directory's timestamps, the way
			// a mount point reports the underlying dentry on Linux.
			if (i >= 0) entries[i] = { ...entries[i], isDir: true, isSymlink: false };
			else entries.push(mountPointEntry(m));
		}

		if (opts?.recursive) {
			for (const m of mountsUnder(path)) {
				const sub = yield* vfs.readdir(c, m.root, opts);
				entries.push(...sub.entries);
				complete = complete && sub.complete;
			}
		}

		return { entries, complete };
	},

	*readFile(c: OpCtx, path: string): Plan<Buffer> {
		const r = resolveMount(path);
		return yield* r.mount.provider.readFile(c, r.local);
	},

	*writeFile(c: OpCtx, path: string, data: Buffer): Plan<void> {
		const r = resolveMount(path);
		assertWritable(r.mount, c);
		yield* r.mount.provider.writeFile(c, r.local, data);
	},

	*mkdir(
		c: OpCtx,
		path: string,
		opts: { recursive: boolean }
	): Plan<string | undefined> {
		const r = resolveMount(path);
		assertWritable(r.mount, c);
		// node reports the first directory a recursive mkdir created; the provider
		// names it in its own local terms, so lift it back onto the mount.
		const first = yield* r.mount.provider.mkdir(c, r.local, opts);
		if (first === undefined) return undefined;
		return r.mount.root === "/" ? first : r.mount.root + first;
	},

	*rm(
		c: OpCtx,
		path: string,
		opts: { recursive: boolean; force: boolean }
	): Plan<void> {
		const r = resolveMount(path);
		assertWritable(r.mount, c);
		yield* r.mount.provider.rm(c, r.local, opts);
	},

	*rename(c: OpCtx, from: string, to: string): Plan<void> {
		const src = resolveMount(from);
		const dst = resolveMount(to);
		assertWritable(src.mount, c);
		assertWritable(dst.mount, c);

		if (src.mount === dst.mount) {
			yield* src.mount.provider.rename(c, src.local, dst.local);
			return;
		}

		// No backend can move bytes into another one, so this degrades to
		// copy-then-delete. Deliberately transparent rather than EXDEV: vite and npm
		// both rename a temp file into place, and those two paths will routinely
		// straddle a mount boundary once node_modules is served from an archive. The
		// cost is that it is not atomic, which is worth stating out loud.
		const entry = yield* src.mount.provider.stat(c, src.local);
		if (entry.isDir) {
			throw createFsError(
				"EXDEV",
				-18,
				"cross-device link not permitted",
				c.syscall,
				from
			);
		}
		const data = yield* src.mount.provider.readFile(c, src.local);
		yield* dst.mount.provider.writeFile(c, dst.local, data);
		yield* src.mount.provider.rm(c, src.local, {
			recursive: false,
			force: false,
		});
	},

	*utimes(
		c: OpCtx,
		path: string,
		atimeMs: number,
		mtimeMs: number
	): Plan<boolean> {
		const r = resolveMount(path);
		assertWritable(r.mount, c);
		return yield* r.mount.provider.utimes(c, r.local, atimeMs, mtimeMs);
	},

	/** Always available: sliced out of a whole-file read when the backend has none. */
	*readRange(
		c: OpCtx,
		path: string,
		offset: number,
		length: number
	): Plan<Buffer> {
		const r = resolveMount(path);
		const p = r.mount.provider;
		if (p.readRange) return yield* p.readRange(c, r.local, offset, length);
		const whole = yield* p.readFile(c, r.local);
		return whole.subarray(offset, offset + length);
	},

	/** Always available: read-then-write when the backend has no server-side copy. */
	*copyFile(
		c: OpCtx,
		from: string,
		to: string,
		opts: { overwrite: boolean }
	): Plan<void> {
		const src = resolveMount(from);
		const dst = resolveMount(to);
		assertWritable(dst.mount, c);

		// The server-side copy is only usable when both ends are the same backend.
		if (src.mount === dst.mount && src.mount.provider.copyFile) {
			yield* src.mount.provider.copyFile(c, src.local, dst.local, opts);
			return;
		}
		if (!opts.overwrite) {
			let exists = true;
			try {
				yield* dst.mount.provider.stat(ctx("stat", to), dst.local);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
				exists = false;
			}
			if (exists) {
				throw createFsError("EEXIST", -17, "file already exists", c.syscall, to);
			}
		}
		const data = yield* src.mount.provider.readFile(c, src.local);
		yield* dst.mount.provider.writeFile(c, dst.local, data);
	},

	*statfs(c: OpCtx, path: string): Plan<{ used: number; capacity: number }> {
		const p = providerFor(path);
		// Nothing meaningful to report for a backend with no notion of capacity.
		if (!p.statfs) return { used: 0, capacity: 0 };
		return yield* p.statfs(c);
	},

	*pin(c: OpCtx, path: string): Plan<unknown> {
		const r = resolveMount(path);
		if (!r.mount.provider.pin) return undefined;
		return yield* r.mount.provider.pin(c, r.local);
	},

	/** Whether a path's backend can stream, so callers can pick a read strategy. */
	canStream(path: string): boolean {
		return !!providerFor(path).openRead;
	},

	/**
	 * Whether a path's backend has a *real* ranged read.
	 *
	 * `readRange` above is always callable, but when derived it pulls the whole file
	 * and slices — so a caller that would otherwise keep a byte-range cache is better
	 * off holding the whole file once. Only this layer knows the difference.
	 */
	hasNativeRange(path: string): boolean {
		return !!providerFor(path).readRange;
	},
};

/** Whether `p` lies inside a mount grafted somewhere beneath `dir`. */
function shadowed(dir: string, p: string): boolean {
	return mountsUnder(dir).some((m) => under(m.root, p));
}
