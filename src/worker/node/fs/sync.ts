import { decode, fetchPuterSync, getRandomId } from "../../puter";
import nodeBuffer from "../buffer";
import nodePath from "../path";
import {
	createFsError,
	fsConstants,
	normalizePath,
	randomTempSuffix,
	translatePuterError,
	type AnyStats,
} from "./util";
import { Stats, StatsFs, Dirent, Dir } from "./classes";
import { SyncFileHandle } from "./handle-sync";
import { fdTable } from "./fd-table";
import { promisesToDepromisify } from "./promises";
import { promisesRemaining } from "./promises-sync";
// @ts-ignore — upstream node JS, glob spec impl backed by minimatch
import { Glob } from "node-core:internal/fs/glob";

type NodeFs = typeof import("node:fs");

let Buffer = nodeBuffer.Buffer;

// Looks up an fd that must be backed by a sync handle (openSync family). An fd
// opened via the async family lives in the same table but isn't a
// SyncFileHandle, so it's rejected here with EBADF.
function getSyncHandle(fd: number, syscall: string): SyncFileHandle {
	const handle = fdTable.get(fd);
	if (!(handle instanceof SyncFileHandle))
		throw createFsError("EBADF", -9, "bad file descriptor", syscall);
	return handle;
}

// Type-level mask: declare exactly the sync surface we implement.
// Excluded keys (the async methods, classes, constants, and unimplemented
// pieces like `watch`/`access`/`truncate`/...) surface as missing-method
// warnings at the `satisfies typeof import("node:fs")` site in `./index.ts`,
// which is the right place to track them.
export let fsSync: Omit<
	NodeFs,
	| "promises"
	| "constants"
	| "Dir"
	| "Dirent"
	| "Stats"
	| "StatsFs"
	| keyof typeof promisesToDepromisify
	| keyof typeof promisesRemaining
> = {
	appendFileSync(path, data, options) {
		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		let old;
		try {
			old = this.readFileSync(path, { encoding: options.encoding });
		} catch {
			old = Buffer.alloc(0);
		}

		let total;
		if (data instanceof Buffer && old instanceof Buffer)
			total = Buffer.concat([old, data]);
		else if (typeof data === "string" && old instanceof Buffer)
			total = Buffer.concat([
				old,
				Buffer.from(data, options.encoding || undefined),
			]);
		else if (data instanceof Buffer && typeof old === "string")
			total = Buffer.concat([
				Buffer.from(old, options.encoding || undefined),
				data,
			]);
		else if (typeof data === "string" && typeof old === "string")
			total = Buffer.concat([
				Buffer.from(old, options.encoding || undefined),
				Buffer.from(data, options.encoding || undefined),
			]);
		else {
			let err = new Error("EINVAL: invalid argument") as NodeJS.ErrnoException;
			err.code = "EINVAL";
			err.errno = -22;
			throw err;
		}

		this.writeFileSync(path, total, {
			flush: options.flush,
			mode: options.mode,
		});
	},
	copyFileSync(src, dest, mode) {
		src = normalizePath(src);
		dest = normalizePath(dest);

		mode ??= 0;
		let overwrite = (mode & fsConstants.COPYFILE_EXCL) === 0;

		if (mode & fsConstants.COPYFILE_FICLONE_FORCE) {
			let err = new Error(
				"EOPNOTSUPP: operation not supported, copyfile"
			) as NodeJS.ErrnoException;
			err.code = "EOPNOTSUPP";
			err.errno = -95;
			err.syscall = "copyfile";
			throw err;
		}

		let destName = nodePath.basename(dest);
		let destDir = nodePath.dirname(dest);
		let [ok, u8array] = fetchPuterSync("copy", {
			source: src,
			destination: destDir,
			new_name: destName,
			overwrite,
			dedupe_name: false,
		});

		if (!ok) {
			let res = decode(u8array);
			throw (
				translatePuterError(res.code, "copyfile", src) ?? new Error(res.message)
			);
		}
	},
	existsSync(path) {
		path = normalizePath(path);
		let [ok] = fetchPuterSync("stat", {
			path,
			return_size: true,
			return_permissions: false,
			return_versions: false,
			consistency: "strong",
		});
		return ok;
	},
	mkdirSync(path, options) {
		path = normalizePath(path);

		if (typeof options === "number" || typeof options === "string")
			options = { mode: options };
		else if (!options) options = {};

		// mode is ignored: puterfs has no POSIX permission bits.

		let recursive = options.recursive || false;
		let dirName = nodePath.basename(path);
		let dirPath = nodePath.dirname(path);
		let [ok, u8array] = fetchPuterSync("mkdir", {
			parent: dirPath,
			path: dirName,
			overwrite: recursive,
			dedupe_name: false,
			create_missing_parents: recursive,
		});
		let res = decode(u8array);

		if (!ok)
			throw (
				translatePuterError(res.code, "mkdir", path) ?? new Error(res.message)
			);

		/*
		if (recursive)
			// TODO it's supposed to parent_directories_created based on puter oss but it's not that and it's also broken
			// this also doesn't handle if the target directory was created
			return res.parent_dirs_created[0];
			*/
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
		path = normalizePath(path);

		if (typeof options === "string") options = { encoding: options } as {};
		else if (!options) options = {};

		let children: any[][] = [];

		let stack: string[] = [path];
		let currentPath: string | undefined;

		while ((currentPath = stack.pop())) {
			let [ok, u8array] = fetchPuterSync("readdir", {
				path: currentPath,
				no_thumbs: true,
				no_assocs: true,
				no_subdomains: true,
				consistency: "strong",
			});
			let res = decode(u8array) as any[];
			if (!ok)
				throw (
					translatePuterError((res as any).code, "scandir", currentPath) ??
					new Error((res as any).message)
				);

			children.push(res);

			if (options.recursive) {
				for (let child of res) {
					if (child.is_dir) {
						stack.push(child.path);
					}
				}
			}
		}

		return children.flat().map((x: any) => {
			let nameBuf = Buffer.from(x.name, "utf8");
			let name: string | Buffer;
			if (options.encoding !== "buffer")
				name = nameBuf.toString(options.encoding || undefined);
			else name = nameBuf;

			if (options.withFileTypes) {
				return new Dirent(name, x);
			} else {
				return name;
			}
		});
	},
	readFileSync(path, options) {
		path = normalizePath(path);

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?
		let [ok, u8array] = fetchPuterSync(
			`read?file=${encodeURIComponent(path)}`,
			undefined
		);

		if (!ok) {
			let res = decode(u8array);
			throw (
				translatePuterError(res.code, "open", path) ?? new Error(res.message)
			);
		}

		let buf = Buffer.from(u8array);
		if (options.encoding)
			// not sure why ts doesn't like this
			return buf.toString(options.encoding) as any;
		else return buf;
	},
	renameSync(oldPath, newPath) {
		oldPath = normalizePath(oldPath);
		newPath = normalizePath(newPath);

		let newName = nodePath.basename(newPath);
		let newDir = nodePath.dirname(newPath);
		let [ok, u8array] = fetchPuterSync("move", {
			source: oldPath,
			destination: newDir,
			new_name: newName,
			overwrite: false,
			create_missing_parents: false,
		});
		if (!ok) {
			let res = decode(u8array);
			throw (
				translatePuterError(res.code, "rename", oldPath) ??
				new Error(res.message)
			);
		}
	},
	rmdirSync(path) {
		return this.unlinkSync(path);
	},
	rmSync(path, options) {
		// TODO retries?
		path = normalizePath(path);

		if (!options) options = {};

		let [ok, u8array] = fetchPuterSync("delete", {
			paths: [path],
			recursive: options.recursive || false,
			descendants_only: false,
		});
		if (!options.force && !ok) {
			let res = decode(u8array);
			throw translatePuterError(res.code, "rm", path) ?? new Error(res.message);
		}
	},
	statSync(path, options?) {
		path = normalizePath(path);
		if (!options) options = {};

		let [ok, u8array] = fetchPuterSync("stat", {
			path,
			return_size: true,
			return_permissions: false,
			return_versions: false,
			consistency: "strong",
		});
		let res = decode(u8array);

		if (!ok)
			throw (
				translatePuterError(res.code, "stat", path) ?? new Error(res.message)
			);

		return new Stats(res, options.bigint || false) as AnyStats;
	},
	// puter fs has no symlinks, so lstat is just stat.
	lstatSync(path, options?) {
		return this.statSync(path, options as any) as AnyStats;
	},
	globSync(pattern, options?) {
		return new Glob(pattern, options).globSync();
	},
	statfsSync(_path, options?) {
		// ignore path, this is puterfs
		if (!options) options = {};

		let [ok, u8array] = fetchPuterSync("df", {});
		let res = decode(u8array);

		if (!ok)
			throw translatePuterError(res.code, "statfs") ?? new Error(res.message);

		return new StatsFs(res, options.bigint || false);
	},
	writeFileSync(file, data, options) {
		file = normalizePath(file);

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?

		let buf;
		if (typeof data === "string")
			buf = Buffer.from(data, options.encoding || undefined);
		else if (data instanceof Buffer) buf = data;
		else if (data instanceof DataView) buf = Buffer.from(data.buffer);
		else if ("buffer" in data) buf = Buffer.from(data.buffer);
		else throw new Error("TODO");

		let name = nodePath.basename(file);
		let path = nodePath.dirname(file);

		let [_ok, u8array] = fetchPuterSync("batch", (form) => {
			let opId = getRandomId();
			form.append("operation_id", opId);
			form.append(
				"fileinfo",
				JSON.stringify({
					name,
					type: "application/octet-stream",
					size: buf.byteLength,
				})
			);
			form.append(
				"operation",
				JSON.stringify({
					op: "write",
					dedupe_name: false,
					overwrite: true,
					operation_id: opId,
					path,
					name,
					item_upload_id: 0,
				})
			);
			form.append("file", new File([buf as unknown as BlobPart], name));
		});
		let res = decode(u8array);

		let result = res.results[0];
		if (result.success === false)
			throw (
				translatePuterError(result.code, "write", file) ??
				new Error(result.message)
			);
	},
	unlinkSync(path) {
		path = normalizePath(path);

		let [ok, u8array] = fetchPuterSync("delete", {
			paths: [path],
			recursive: false,
			descendants_only: false,
		});
		if (!ok) {
			let res = decode(u8array);
			throw (
				translatePuterError(res.code, "unlink", path) ?? new Error(res.message)
			);
		}
	},
	realpathSync(path: any, options: any) {
		if (typeof options == "string") options = { encoding: options };
		else if (!options) options = {};
		if (path instanceof URL) throw new Error("TODO");
		if (typeof path == "string") path = Buffer.from(path);

		if (options.encoding == "buffer") return path;
		else return path.toString(options.encoding || "utf8");
	},
	// Existence + permission probe. puterfs has no real permission bits, so only
	// F_OK can fail (surfaced as ENOENT by the stat).
	accessSync(path, _mode?) {
		this.statSync(path);
	},
	truncateSync(path, len?) {
		path = normalizePath(path);
		len ??= 0;
		if (!Number.isInteger(len)) len = Math.trunc(len);
		if (len < 0) len = 0;

		let buf = this.readFileSync(path) as Buffer;
		let out: Buffer;
		if (len <= buf.length) out = buf.subarray(0, len) as Buffer;
		else {
			out = Buffer.alloc(len);
			buf.copy(out, 0);
		}
		this.writeFileSync(path, out);
	},
	cpSync(source, destination, opts?) {
		let options = (opts || {}) as any;
		let force = options.force !== false;
		let errorOnExist = options.errorOnExist || false;
		let recursive = options.recursive || false;
		let filter = options.filter as
			| ((s: string, d: string) => boolean)
			| undefined;

		let self = this;
		function copyEntry(src: string, dest: string): void {
			if (filter && !filter(src, dest)) return;

			let srcStat = self.statSync(src);
			if (srcStat.isDirectory()) {
				if (!recursive)
					throw createFsError(
						"EISDIR",
						-21,
						"recursive option not enabled, cannot copy a directory",
						"cp",
						src
					);
				self.mkdirSync(dest, { recursive: true });
				let entries = self.readdirSync(src) as string[];
				for (let entry of entries)
					copyEntry(nodePath.join(src, entry), nodePath.join(dest, entry));
				return;
			}

			let destExists = self.existsSync(dest);
			if (destExists) {
				if (errorOnExist)
					throw createFsError("EEXIST", -17, "file already exists", "cp", dest);
				if (!force) return;
			}
			self.copyFileSync(src, dest);
		}

		copyEntry(normalizePath(source as any), normalizePath(destination as any));
	},
	mkdtempSync(prefix, options?) {
		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		let path = normalizePath((prefix as any) + randomTempSuffix());
		this.mkdirSync(path);

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
	// --- numeric fd family (sync), backed by SyncFileHandle ---
	openSync(path, flags?, _mode?) {
		return SyncFileHandle.open(path as any, flags).fd;
	},
	closeSync(fd) {
		getSyncHandle(fd, "close").close();
	},
	readSync(fd, buffer, offsetOrOptions?: any, length?: any, position?: any) {
		let handle = getSyncHandle(fd, "read");
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
		return handle.read(buffer, offset, len, pos);
	},
	writeSync(
		fd,
		data,
		offsetOrPositionOrOptions?: any,
		lengthOrEncoding?: any,
		position?: any
	) {
		let handle = getSyncHandle(fd, "write");

		if (typeof data === "string") {
			// writeSync(fd, string, position?, encoding?)
			let pos =
				typeof offsetOrPositionOrOptions === "number"
					? offsetOrPositionOrOptions
					: null;
			let encoding =
				typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8";
			let buf = Buffer.from(data, encoding as BufferEncoding);
			return handle.write(buf, pos);
		}

		let src = Buffer.isBuffer(data)
			? data
			: Buffer.from(
					(data as NodeJS.ArrayBufferView).buffer,
					(data as NodeJS.ArrayBufferView).byteOffset,
					(data as NodeJS.ArrayBufferView).byteLength
				);

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
		return handle.write(src.subarray(offset, offset + len) as Buffer, pos);
	},
	fstatSync(fd, options?) {
		return getSyncHandle(fd, "fstat").stat((options as any)?.bigint || false);
	},
	fsyncSync(fd) {
		getSyncHandle(fd, "fsync").sync();
	},
	fdatasyncSync(fd) {
		getSyncHandle(fd, "fdatasync").sync();
	},
	ftruncateSync(fd, len?) {
		getSyncHandle(fd, "ftruncate").truncate(len ?? 0);
	},
	readvSync(fd, buffers, position?) {
		let handle = getSyncHandle(fd, "readv");
		let total = 0;
		let pos = position ?? null;
		for (let buffer of buffers) {
			let bytesRead = handle.read(buffer, 0, buffer.byteLength, pos);
			total += bytesRead;
			if (pos !== null) pos += bytesRead;
			if (bytesRead < buffer.byteLength) break;
		}
		return total;
	},
	writevSync(fd, buffers, position?) {
		let handle = getSyncHandle(fd, "writev");
		let total = 0;
		let pos = position ?? null;
		for (let buffer of buffers) {
			let buf = Buffer.isBuffer(buffer)
				? buffer
				: Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
			let bytesWritten = handle.write(buf as Buffer, pos);
			total += bytesWritten;
			if (pos !== null) pos += bytesWritten;
		}
		return total;
	},
	// puterfs has no mode/owner bits; validate the fd and no-op.
	fchmodSync(fd, _mode) {
		getSyncHandle(fd, "fchmod");
	},
	fchownSync(fd, _uid, _gid) {
		getSyncHandle(fd, "fchown");
	},
};
