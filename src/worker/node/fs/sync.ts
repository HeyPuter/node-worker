// The synchronous half of the node:fs surface.
//
// Every method here is argument handling — node's overload sets, option coercion,
// CWD joining, encoding, `bigint`, building `Stats`/`Dirent` — wrapped around a plan
// run with the blocking driver. The filesystem semantics live in ./vfs and ./ops and
// are shared byte-for-byte with ./promises.ts, which does the same argument handling
// around `runAsync`. Before that split existed the two files were near-identical
// copies of the same logic that had to be kept in step by hand.
//
// The rule for reading this file: if something here talks about paths, options, or
// node's classes it belongs here; if it talks about requests or filesystem behavior
// it belongs below and this is a bug.

import nodeBuffer from "../buffer";
import {
	createFsError,
	fsConstants,
	normalizePath,
	toWriteBuffer,
	type AnyStats,
} from "./util";
import { encodeEntry } from "./readdir-recursive";
import { runSync } from "./driver";
import { ctx, vfs } from "./vfs";
import { utimesPlan } from "./times";
import {
	accessPlan,
	appendFilePlan,
	cpPlan,
	existsPlan,
	mkdtempPlan,
	truncatePlan,
} from "./ops";
import { Stats, StatsFs, Dirent, Dir } from "./classes";
import { FileHandle } from "./handle";
import { fdTable } from "./fd-table";
// Type-only: these are used solely in the `Omit` below. A runtime import would
// put ./sync.ts back inside the glob module-init cycle (see ./glob.ts).
import type { promisesToDepromisify } from "./promises";
import type { promisesRemaining } from "./promises-sync";

type NodeFs = typeof import("node:fs");

let Buffer = nodeBuffer.Buffer;

// Looks up an open fd. There is one handle class and one table, so an fd from
// `open` and one from `openSync` are equally valid here — which is node's
// behavior, and a change from the two-class split this replaced.
function getHandle(fd: number, syscall: string): FileHandle {
	const handle = fdTable.get(fd);
	if (!(handle instanceof FileHandle))
		throw createFsError("EBADF", -9, "bad file descriptor", syscall);
	return handle;
}

// puterfs has no symlinks and no path-based link api (only `/mkshortcut`, which
// targets a uid and can't dangle), so rather than emulate them badly these
// report the errno a filesystem without the feature would: tar, fs-extra and
// friends already have a fallback path for it. `readlink` distinguishes "exists
// but isn't a link" (EINVAL, node's own errno) from "isn't there" (ENOENT).
function noLinks(syscall: string, path: string): never {
	throw createFsError("EPERM", -1, "operation not permitted", syscall, path);
}

// Not a member of `fsSync` — see `realpathSync` below, which needs a `.native`
// pointing back at itself.
function realpathSyncImpl(path: any, options?: any) {
	if (typeof options == "string") options = { encoding: options };
	else if (!options) options = {};
	if (path instanceof URL) throw new Error("TODO");
	if (typeof path == "string") path = Buffer.from(path);

	if (options.encoding == "buffer") return path;
	else return path.toString(options.encoding || "utf8");
}

// Type-level mask: declare exactly the sync surface we implement.
// Excluded keys (the async methods, classes, constants, and the watcher family,
// which lives in ./watch.ts) surface as missing-method warnings at the
// `satisfies typeof import("node:fs")` site in `./index.ts`, which is the right
// place to track them.
export let fsSync: Omit<
	NodeFs,
	// Containers and constants, assembled in ./index.ts
	| "promises"
	| "constants"
	| "Dir"
	| "Dirent"
	| "Stats"
	| "StatsFs"
	| "exists"
	// ./watch.ts
	| "watchFile"
	| "unwatchFile"
	// ./streams.ts
	| "createReadStream"
	| "createWriteStream"
	| "ReadStream"
	| "WriteStream"
	| "Utf8Stream"
	// ./glob.ts
	| "glob"
	| "globSync"
	// ./fd.ts — the callback-style numeric-fd family
	| "close"
	| "read"
	| "write"
	| "fstat"
	| "fsync"
	| "fdatasync"
	| "ftruncate"
	| "readv"
	| "writev"
	| "fchmod"
	| "fchown"
	| "futimes"
	// The promise impls, depromisified in ./index.ts
	| keyof typeof promisesToDepromisify
	| keyof typeof promisesRemaining
> = {
	appendFileSync(path, data, options) {
		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		let p = normalizePath(path);
		runSync(appendFilePlan(p, toWriteBuffer(data, options.encoding)));
	},
	copyFileSync(src, dest, mode) {
		let from = normalizePath(src);
		let to = normalizePath(dest);

		mode ??= 0;
		let overwrite = (mode & fsConstants.COPYFILE_EXCL) === 0;

		if (mode & fsConstants.COPYFILE_FICLONE_FORCE) {
			throw createFsError(
				"EOPNOTSUPP",
				-95,
				"operation not supported",
				"copyfile"
			);
		}

		runSync(vfs.copyFile(ctx("copyfile", from), from, to, { overwrite }));
	},
	existsSync(path) {
		// node's `existsSync` never throws — it answers false for *any* failure, not
		// just ENOENT. `existsPlan` is deliberately stricter than that (its other
		// callers want to hear about a 500 rather than silently treat it as "absent"),
		// so the swallowing belongs here, at the node boundary.
		try {
			return runSync(existsPlan(normalizePath(path)));
		} catch {
			return false;
		}
	},
	mkdirSync(path, options) {
		let p = normalizePath(path);

		if (typeof options === "number" || typeof options === "string")
			options = { mode: options };
		else if (!options) options = {};

		// mode is ignored: puterfs has no POSIX permission bits.
		let recursive = options.recursive || false;
		let first = runSync(vfs.mkdir(ctx("mkdir", p), p, { recursive }));
		// node's recursive mkdir returns the first directory it created, or undefined.
		// The api doesn't reliably report it, so this is undefined more often than on
		// a real filesystem.
		return recursive ? first : undefined;
	},
	opendirSync(path, options?) {
		path = normalizePath(path);

		let entries = this.readdirSync(path, {
			withFileTypes: true,
			recursive: options?.recursive,
			encoding: options?.encoding,
		}) as InstanceType<typeof Dirent>[];
		return new Dir(path, entries);
	},
	readdirSync(path, options?) {
		let p = normalizePath(path);

		if (typeof options === "string") options = { encoding: options } as {};
		else if (!options) options = {};

		// Same plan as the async twin; the only difference is which driver runs it.
		let listing = runSync(
			vfs.readdir(ctx("scandir", p), p, { recursive: options.recursive })
		);
		return listing.entries.map((entry) => encodeEntry(entry, p, options));
	},
	readFileSync(path, options) {
		let p = normalizePath(path);

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag is accepted and ignored: puterfs has no open modes to honor.
		let buf = runSync(vfs.readFile(ctx("open", p), p));
		if (options.encoding)
			// not sure why ts doesn't like this
			return buf.toString(options.encoding) as any;
		else return buf;
	},
	renameSync(oldPath, newPath) {
		let from = normalizePath(oldPath);
		let to = normalizePath(newPath);
		runSync(vfs.rename(ctx("rename", from), from, to));
	},
	rmdirSync(path) {
		return this.unlinkSync(path);
	},
	rmSync(path, options) {
		// TODO retries?
		let p = normalizePath(path);
		if (!options) options = {};

		runSync(
			vfs.rm(ctx("rm", p), p, {
				recursive: options.recursive || false,
				force: options.force || false,
			})
		);
	},
	statSync(path, options?) {
		let p = normalizePath(path);
		if (!options) options = {};

		let entry = runSync(vfs.stat(ctx("stat", p), p));
		return new Stats(entry, options.bigint || false) as AnyStats;
	},
	// puter fs has no symlinks, so lstat is just stat.
	lstatSync(path, options?) {
		return this.statSync(path, options as any) as AnyStats;
	},
	statfsSync(path, options?) {
		if (!options) options = {};

		// The path selects which backend answers, but its capacity report covers the
		// whole of that backend rather than the subtree — as `statfs(2)` does.
		let p = normalizePath(path);
		let df = runSync(vfs.statfs(ctx("statfs", p), p));
		return new StatsFs(df, options.bigint || false);
	},
	writeFileSync(file, data, options) {
		let p = normalizePath(file);

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag is accepted and ignored: puterfs has no open modes to honor.
		let buf = toWriteBuffer(data, options.encoding);
		runSync(vfs.writeFile(ctx("write", p), p, buf));
	},
	unlinkSync(path) {
		let p = normalizePath(path);
		runSync(vfs.rm(ctx("unlink", p), p, { recursive: false, force: false }));
	},
	// puterfs resolves nothing — no symlinks, no shortcuts on the read path — so
	// the real path is the path. `.native` is the same impl, as in node on a
	// filesystem with nothing to resolve.
	realpathSync: Object.assign(realpathSyncImpl, {
		native: realpathSyncImpl,
	}) as NodeFs["realpathSync"],
	// Existence + permission probe. puterfs has no real permission bits, so only
	// F_OK can fail (surfaced as ENOENT by the stat).
	accessSync(path, _mode?) {
		runSync(accessPlan(normalizePath(path)));
	},
	truncateSync(path, len?) {
		let p = normalizePath(path);
		runSync(truncatePlan(p, len ?? 0));
	},
	cpSync(source, destination, opts?) {
		let options = (opts || {}) as any;
		runSync(
			cpPlan(normalizePath(source as any), normalizePath(destination as any), {
				force: options.force,
				errorOnExist: options.errorOnExist,
				recursive: options.recursive,
				filter: options.filter,
			})
		);
	},
	mkdtempSync(prefix, options?) {
		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		let path = runSync(mkdtempPlan(normalizePath(prefix as any)));

		let nameBuf = Buffer.from(path, "utf8");
		if ((options as any).encoding === "buffer") return nameBuf as any;
		return nameBuf.toString((options as any).encoding || undefined) as any;
	},
	mkdtempDisposableSync(prefix, options?) {
		let path = this.mkdtempSync(prefix, options as any) as string;
		let self = this;
		let removed = false;
		let remove = () => {
			if (removed) return;
			removed = true;
			self.rmSync(path, { recursive: true, force: true });
		};
		return {
			path,
			remove,
			[Symbol.dispose]: remove,
		} as any;
	},
	// See `noLinks` above for why these report EPERM rather than emulating.
	linkSync(_existingPath, newPath) {
		noLinks("link", normalizePath(newPath as any));
	},
	symlinkSync(_target, path, _type?) {
		noLinks("symlink", normalizePath(path as any));
	},
	readlinkSync(path, _options?) {
		// EINVAL is node's errno for readlink on something that isn't a link, so
		// the stat is load-bearing: it's what distinguishes that from ENOENT.
		let resolved = normalizePath(path as any);
		this.statSync(resolved);
		throw createFsError(
			"EINVAL",
			-22,
			"invalid argument",
			"readlink",
			resolved
		);
	},
	// The only timestamp api is `POST /touch`, whose fields are
	// `set_{modified,accessed,created}_to_now` — there is no way to set an
	// arbitrary value. So a request for ~now is honored for real, and anything
	// else validates the path and no-ops rather than throwing, matching how
	// chmod/chown already behave here.
	utimesSync(path, atime, mtime) {
		let p = normalizePath(path as any);
		// `false` means the backend couldn't represent the requested times (puterfs can
		// only set them to *now*), so nothing was sent — but a missing path still owes
		// the caller an ENOENT, which the stat provides.
		if (!runSync(utimesPlan(p, atime, mtime))) this.statSync(p);
	},
	// Nothing can be a symlink, so there is no link to *not* follow.
	lutimesSync(path, atime, mtime) {
		this.utimesSync(path, atime, mtime);
	},
	futimesSync(fd, atime, mtime) {
		this.utimesSync(getHandle(fd, "futime").filePath, atime, mtime);
	},
	// puterfs has no mode/owner bits; validate existence then no-op.
	chmodSync(path, _mode) {
		this.statSync(path);
	},
	lchmodSync(path, _mode) {
		this.statSync(path);
	},
	chownSync(path, _uid, _gid) {
		this.statSync(path);
	},
	lchownSync(path, _uid, _gid) {
		this.statSync(path);
	},
	async openAsBlob(path, options?) {
		let buf = this.readFileSync(path) as Buffer;
		return new Blob([buf as unknown as BlobPart], {
			type: (options as any)?.type ?? "",
		});
	},
	// --- numeric fd family (sync) ---
	//
	// The same `FileHandle` the async family uses, driven with the blocking driver.
	// An fd opened here is therefore usable with `fs.read`, `fs.promises` and
	// `createReadStream({fd})`, which is node's behavior and which the previous
	// two-class split rejected with EBADF.
	openSync(path, flags?, _mode?) {
		return FileHandle.openSync(path as any, flags).fd;
	},
	closeSync(fd) {
		runSync(getHandle(fd, "close").closePlan());
	},
	readSync(fd, buffer, offsetOrOptions?: any, length?: any, position?: any) {
		let handle = getHandle(fd, "read");
		let offset: number;
		let len: number;
		let pos: number | null;
		if (typeof offsetOrOptions === "object" && offsetOrOptions !== null) {
			offset = offsetOrOptions.offset ?? 0;
			len = offsetOrOptions.length ?? buffer.byteLength - offset;
			pos = offsetOrOptions.position ?? null;
		} else {
			offset = offsetOrOptions ?? 0;
			len = length ?? buffer.byteLength - offset;
			pos = position ?? null;
		}
		if (typeof pos === "bigint") pos = Number(pos);
		return runSync(handle.readPlan(buffer, offset, len, pos));
	},
	writeSync(
		fd,
		data,
		offsetOrPositionOrOptions?: any,
		lengthOrEncoding?: any,
		position?: any
	) {
		let handle = getHandle(fd, "write");

		if (typeof data === "string") {
			// writeSync(fd, string, position?, encoding?)
			let pos =
				typeof offsetOrPositionOrOptions === "number"
					? offsetOrPositionOrOptions
					: null;
			let encoding =
				typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8";
			return runSync(
				handle.writePlan(toWriteBuffer(data, encoding as BufferEncoding), pos)
			);
		}

		let src = toWriteBuffer(data);

		let offset: number;
		let len: number;
		let pos: number | null;
		if (
			typeof offsetOrPositionOrOptions === "object" &&
			offsetOrPositionOrOptions !== null
		) {
			offset = offsetOrPositionOrOptions.offset ?? 0;
			len = offsetOrPositionOrOptions.length ?? src.byteLength - offset;
			pos = offsetOrPositionOrOptions.position ?? null;
		} else {
			offset = offsetOrPositionOrOptions ?? 0;
			len = lengthOrEncoding;
			if (typeof len !== "number") len = src.byteLength - offset;
			pos = position ?? null;
		}
		if (typeof pos === "bigint") pos = Number(pos);
		return runSync(handle.writePlan(src.subarray(offset, offset + len), pos));
	},
	fstatSync(fd, options?) {
		return runSync(
			getHandle(fd, "fstat").statPlan((options as any)?.bigint || false)
		) as AnyStats;
	},
	fsyncSync(fd) {
		runSync(getHandle(fd, "fsync").syncPlan());
	},
	fdatasyncSync(fd) {
		runSync(getHandle(fd, "fdatasync").syncPlan());
	},
	ftruncateSync(fd, len?) {
		runSync(getHandle(fd, "ftruncate").truncatePlan(len ?? 0));
	},
	readvSync(fd, buffers, position?) {
		let handle = getHandle(fd, "readv");
		let total = 0;
		let pos = position ?? null;
		for (let buffer of buffers) {
			let bytesRead = runSync(
				handle.readPlan(buffer, 0, buffer.byteLength, pos)
			);
			total += bytesRead;
			if (pos !== null) pos += bytesRead;
			if (bytesRead < buffer.byteLength) break;
		}
		return total;
	},
	writevSync(fd, buffers, position?) {
		let handle = getHandle(fd, "writev");
		let total = 0;
		let pos = position ?? null;
		for (let buffer of buffers) {
			let bytesWritten = runSync(
				handle.writePlan(toWriteBuffer(buffer), pos)
			);
			total += bytesWritten;
			if (pos !== null) pos += bytesWritten;
		}
		return total;
	},
	// puterfs has no mode/owner bits; validate the fd and no-op.
	fchmodSync(fd, _mode) {
		getHandle(fd, "fchmod");
	},
	fchownSync(fd, _uid, _gid) {
		getHandle(fd, "fchown");
	},
};
