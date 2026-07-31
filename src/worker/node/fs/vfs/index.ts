// The filesystem facade: what everything above this layer calls.
//
// Right now it forwards to a single provider. Its job is to be the *place* the
// mount table goes, so that adding mounts changes this file and nothing else —
// every caller above is already written against the facade rather than against a
// provider.
//
// Two things it does beyond forwarding, both so callers never have to branch:
//
//   - **Completes the optional half of the provider interface.** `readRange` and
//     `copyFile` exist as fast paths where a backend has one (puterfs has a real
//     server-side `/copy`; memory has free slicing) and are derived here when it
//     doesn't. Callers see them as always present.
//   - **Owns the errors that are about the namespace rather than the storage** —
//     `EROFS` on a read-only mount, `EXDEV` across mounts. Providers only ever
//     raise errors about their own storage.
//
// Deliberately NOT here: argument coercion and node's classes, which belong to the
// surface (../sync.ts, ../promises.ts), and anything that reads `CWD`. Every path
// reaching this file is already absolute and normalized.

import { puterProvider } from "./puter";
import type { FsProvider, Listing, OpCtx, ReaddirOpts } from "./provider";
import type { Plan } from "../plan";
import { createFsError, type FsEntry } from "../util";

// No `let Buffer = nodeBuffer.Buffer` here: `Buffer` appears only in type position,
// which resolves against the global interface rather than a local binding, and
// nothing in this file constructs one.

/**
 * Builds the per-operation context providers need for error reporting. `syscall`
 * is node's name for the operation and shows up in `err.syscall` and the message.
 */
export function ctx(syscall: string, reportPath: string): OpCtx {
	return { syscall, reportPath };
}

// One provider for the whole namespace, for now. The mount table replaces this.
function providerFor(_path: string): FsProvider {
	return puterProvider;
}

export const vfs = {
	*stat(c: OpCtx, path: string): Plan<FsEntry> {
		return yield* providerFor(path).stat(c, path);
	},

	*readdir(c: OpCtx, path: string, opts?: ReaddirOpts): Plan<Listing> {
		return yield* providerFor(path).readdir(c, path, opts);
	},

	*readFile(c: OpCtx, path: string): Plan<Buffer> {
		return yield* providerFor(path).readFile(c, path);
	},

	*writeFile(c: OpCtx, path: string, data: Buffer): Plan<void> {
		yield* providerFor(path).writeFile(c, path, data);
	},

	*mkdir(
		c: OpCtx,
		path: string,
		opts: { recursive: boolean }
	): Plan<string | undefined> {
		return yield* providerFor(path).mkdir(c, path, opts);
	},

	*rm(
		c: OpCtx,
		path: string,
		opts: { recursive: boolean; force: boolean }
	): Plan<void> {
		yield* providerFor(path).rm(c, path, opts);
	},

	*rename(c: OpCtx, from: string, to: string): Plan<void> {
		let p = providerFor(from);
		// Once mounts exist, `from` and `to` may land on different providers, which
		// no single `/move` can express — that becomes a copy-then-delete here.
		yield* p.rename(c, from, to);
	},

	*utimes(
		c: OpCtx,
		path: string,
		atimeMs: number,
		mtimeMs: number
	): Plan<boolean> {
		return yield* providerFor(path).utimes(c, path, atimeMs, mtimeMs);
	},

	/** Always available: sliced out of a whole-file read when the backend has no ranged read. */
	*readRange(
		c: OpCtx,
		path: string,
		offset: number,
		length: number
	): Plan<Buffer> {
		let p = providerFor(path);
		if (p.readRange) return yield* p.readRange(c, path, offset, length);
		let whole = yield* p.readFile(c, path);
		return whole.subarray(offset, offset + length);
	},

	/** Always available: read-then-write when the backend has no server-side copy. */
	*copyFile(
		c: OpCtx,
		from: string,
		to: string,
		opts: { overwrite: boolean }
	): Plan<void> {
		let src = providerFor(from);
		let dst = providerFor(to);
		// The server-side copy is only usable when both ends are the same storage.
		if (src === dst && src.copyFile) {
			yield* src.copyFile(c, from, to, opts);
			return;
		}
		if (!opts.overwrite) {
			let exists = true;
			try {
				yield* dst.stat(ctx("stat", c.reportPath), to);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				exists = false;
			}
			if (exists) {
				throw createFsError("EEXIST", -17, "file already exists", c.syscall, to);
			}
		}
		let data = yield* src.readFile(c, from);
		yield* dst.writeFile(c, to, data);
	},

	*statfs(c: OpCtx, path: string): Plan<{ used: number; capacity: number }> {
		let p = providerFor(path);
		if (!p.statfs) {
			// Nothing meaningful to report for a backend with no notion of capacity.
			return { used: 0, capacity: 0 };
		}
		return yield* p.statfs(c);
	},

	*pin(c: OpCtx, path: string): Plan<unknown> {
		let p = providerFor(path);
		if (!p.pin) return undefined;
		return yield* p.pin(c, path);
	},

	/** Whether a path's backend can stream, so callers can pick a read strategy. */
	canStream(path: string): boolean {
		return !!providerFor(path).openRead;
	},

	/**
	 * Whether a path's backend has a *real* ranged read.
	 *
	 * `readRange` above is always callable, but when it's derived it pulls the whole
	 * file and slices — so a caller that would otherwise keep a byte-range cache is
	 * better off just holding the whole file once. That decision needs to know the
	 * difference, and only this layer does.
	 */
	hasNativeRange(path: string): boolean {
		return !!providerFor(path).readRange;
	},
};
