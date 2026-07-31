// Operations that are compositions of other operations rather than backend
// primitives.
//
// These sit above the mount layer on purpose: `cp` between two different mounts has
// to become read-then-write, and `truncate` on any backend is read-modify-write
// because no backend here can write part of a file. Pushing them down into
// providers would mean every provider reimplementing them.
//
// They are plans, so `yield*` composes them with the facade's own plans for free
// and the sync and async surfaces share one copy.

import nodePath from "../path";
import nodeBuffer from "../buffer";
import type { Plan } from "./plan";
import { ctx, vfs } from "./vfs";
import { createFsError, randomTempSuffix, type FsEntry } from "./util";

let Buffer = nodeBuffer.Buffer;

/**
 * Existence probe. puterfs has no real permission bits — `Stats.mode` is a constant
 * `type | 0o777` — so R/W/X_OK can never fail and only F_OK is a real question,
 * which is what the stat answers.
 */
export function* existsPlan(path: string): Plan<boolean> {
	try {
		yield* vfs.stat(ctx("stat", path), path);
		return true;
	} catch (err) {
		let code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw err;
	}
}

/** `access`, which differs from `exists` only in reporting the failure. */
export function* accessPlan(path: string): Plan<void> {
	yield* vfs.stat(ctx("access", path), path);
}

export function* appendFilePlan(
	path: string,
	data: Buffer,
	syscall = "open"
): Plan<void> {
	let c = ctx(syscall, path);

	// Reading the existing bytes as a Buffer rather than as text: appending is a
	// byte operation, and decoding then re-encoding would corrupt any file that
	// isn't valid text in the requested encoding.
	let old: Buffer;
	try {
		old = yield* vfs.readFile(c, path);
	} catch (err) {
		// ONLY a missing file means "start from empty". This used to be a bare
		// `catch`, which turned every other failure — a 500, EACCES, EISDIR, an
		// aborted read — into a silent truncation: the append would proceed with an
		// empty base and write back only the new data, destroying the file it was
		// supposed to extend.
		let code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
		old = Buffer.alloc(0);
	}

	yield* vfs.writeFile(c, path, Buffer.concat([old, data]));
}

export function* truncatePlan(path: string, len: number): Plan<void> {
	let c = ctx("open", path);

	if (!Number.isInteger(len)) len = Math.trunc(len);
	if (len < 0) len = 0;

	// Truncating to zero needs no read at all — the old contents are being discarded.
	// The general path below would download the whole file first just to drop it.
	if (len === 0) {
		yield* vfs.writeFile(c, path, Buffer.alloc(0));
		return;
	}

	let buf = yield* vfs.readFile(c, path);
	let out: Buffer;
	if (len <= buf.length) {
		out = buf.subarray(0, len);
	} else {
		// Growing a file zero-fills, as ftruncate(2) does.
		out = Buffer.alloc(len);
		buf.copy(out, 0);
	}
	yield* vfs.writeFile(c, path, out);
}

export function* mkdtempPlan(prefix: string): Plan<string> {
	let path = prefix + randomTempSuffix();
	yield* vfs.mkdir(ctx("mkdir", path), path, { recursive: false });
	return path;
}

/**
 * Recursive copy, with a synchronous filter.
 *
 * `fs.promises.cp` also accepts a filter returning a promise, which a plan cannot
 * await, so the async surface drives its own walk over the same facade calls rather
 * than reusing this. That is the one place where the sync and async surfaces
 * genuinely cannot share an implementation, and the reason is a user callback in the
 * middle of the operation rather than anything about the transport.
 */
export function* cpPlan(
	source: string,
	destination: string,
	opts: {
		force?: boolean;
		errorOnExist?: boolean;
		recursive?: boolean;
		filter?: (src: string, dest: string) => boolean;
	}
): Plan<void> {
	let force = opts.force !== false;
	let errorOnExist = opts.errorOnExist || false;
	let recursive = opts.recursive || false;

	function* copyEntry(src: string, dest: string): Plan<void> {
		if (opts.filter && !opts.filter(src, dest)) return;

		let srcStat: FsEntry = yield* vfs.stat(ctx("stat", src), src);
		if (srcStat.isDir) {
			if (!recursive) {
				throw createFsError(
					"EISDIR",
					-21,
					"recursive option not enabled, cannot copy a directory",
					"cp",
					src
				);
			}
			yield* vfs.mkdir(ctx("mkdir", dest), dest, { recursive: true });
			let listing = yield* vfs.readdir(ctx("scandir", src), src);
			for (let entry of listing.entries) {
				yield* copyEntry(
					nodePath.join(src, entry.name),
					nodePath.join(dest, entry.name)
				);
			}
			return;
		}

		if (yield* existsPlan(dest)) {
			if (errorOnExist) {
				throw createFsError("EEXIST", -17, "file already exists", "cp", dest);
			}
			if (!force) return;
		}
		yield* vfs.copyFile(ctx("copyfile", src), src, dest, { overwrite: true });
	}

	yield* copyEntry(source, destination);
}
