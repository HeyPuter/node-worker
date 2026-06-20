import { decode, fetchPuter, getRandomId } from "../../puter";
import nodeBuffer from "../buffer";
import nodeStream from "../stream";
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
import { FileHandle } from "./handle";
import { streamToBuffer } from "../utils";

type NodeFs = typeof import("node:fs");
type NodeFsPromises = NodeFs["promises"];

let Buffer = nodeBuffer.Buffer;

export let promisesToDepromisify: Omit<
	NodeFsPromises,
	"watch" | "glob" | "constants"
> = {
	async appendFile(path, data, options) {
		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		let old;
		try {
			old = await this.readFile(path, { encoding: options.encoding });
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

		await this.writeFile(path, total, {
			flush: options.flush,
			mode: options.mode,
		});
	},
	async copyFile(src, dest, mode) {
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
		let [ok, u8array] = await fetchPuter("copy", {
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
	async mkdir(path, options) {
		path = normalizePath(path);

		if (typeof options === "number" || typeof options === "string")
			options = { mode: options };
		else if (!options) options = {};

		// mode is ignored: puterfs has no POSIX permission bits.

		let recursive = options.recursive || false;
		let dirName = nodePath.basename(path);
		let dirPath = nodePath.dirname(path);
		let [ok, u8array] = await fetchPuter("mkdir", {
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

		if (recursive)
			// node returns the first directory created (or undefined). puterfs
			// doesn't reliably report this (the field is absent), so guard the
			// access and return undefined rather than throwing.
			// TODO surface the real first-created path once the backend provides it.
			return res?.parent_dirs_created?.[0];
	},
	async opendir(path, options?) {
		path = normalizePath(path);

		let entries = (await this.readdir(path, {
			withFileTypes: true,
			recursive: options?.recursive,
			encoding: options?.encoding,
		})) as InstanceType<typeof Dirent>[];
		return new Dir(path, entries);
	},
	async open(path, flags?, mode?) {
		void mode;
		return await FileHandle.open(path, flags);
	},
	async readdir(path, options?) {
		path = normalizePath(path);

		if (typeof options === "string") options = { encoding: options } as {};
		else if (!options) options = {};

		let children: any[][] = [];

		let stack: string[] = [path];
		let currentPath: string | undefined;

		while ((currentPath = stack.pop())) {
			let [ok, u8array] = await fetchPuter("readdir", {
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
	async readFile(path, options) {
		path = normalizePath(path as any);

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?
		let [ok, u8array] = await fetchPuter(
			`read?file=${encodeURIComponent(path)}`,
			undefined,
			options.signal
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
	async rename(oldPath, newPath) {
		oldPath = normalizePath(oldPath);
		newPath = normalizePath(newPath);

		let newName = nodePath.basename(newPath);
		let newDir = nodePath.dirname(newPath);
		let [ok, u8array] = await fetchPuter("move", {
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
	async rmdir(path) {
		return await this.unlink(path);
	},
	async rm(path, options) {
		// TODO retries?
		path = normalizePath(path);

		if (!options) options = {};

		let [ok, u8array] = await fetchPuter("delete", {
			paths: [path],
			recursive: options.recursive || false,
			descendants_only: false,
		});
		if (!options.force && !ok) {
			let res = decode(u8array);
			throw translatePuterError(res.code, "rm", path) ?? new Error(res.message);
		}
	},
	async stat(path, options?) {
		path = normalizePath(path);
		if (!options) options = {};

		let [ok, u8array] = await fetchPuter("stat", {
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
	// puter fs has no symlinks; lstat is just stat.
	async lstat(path, options?) {
		return (await this.stat(path, options as any)) as AnyStats;
	},
	async statfs(_path, options?) {
		// ignore path, this is puterfs
		if (!options) options = {};

		let [ok, u8array] = await fetchPuter("df", {});
		let res = decode(u8array);

		if (!ok)
			throw translatePuterError(res.code, "statfs") ?? new Error(res.message);

		return new StatsFs(res, options.bigint || false);
	},
	async writeFile(file, data, options) {
		file = normalizePath(file as any);

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?

		let buf;
		if (typeof data === "string")
			buf = Buffer.from(data, options.encoding || undefined);
		else if (data instanceof Buffer) buf = data;
		else if (data instanceof DataView) buf = Buffer.from(data.buffer);
		else if (data instanceof nodeStream.Readable)
			buf = await streamToBuffer(data);
		else if ("buffer" in data) buf = Buffer.from(data.buffer);
		else throw new Error("TODO");

		let name = nodePath.basename(file);
		let path = nodePath.dirname(file);

		let [_ok, u8array] = await fetchPuter(
			"batch",
			(form) => {
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
			},
			options.signal
		);
		let res = decode(u8array);

		let result = res.results[0];
		if (result.success === false)
			throw (
				translatePuterError(result.code, "write", file) ??
				new Error(result.message)
			);
	},
	async unlink(path) {
		path = normalizePath(path);

		let [ok, u8array] = await fetchPuter("delete", {
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
	async realpath(path: any, options: any) {
		if (typeof options == "string") options = { encoding: options };
		else if (!options) options = {};
		if (path instanceof URL) throw new Error("TODO");
		if (typeof path == "string") path = Buffer.from(path);

		if (options.encoding == "buffer") return path;
		else return path.toString(options.encoding || "utf8");
	},
	// Existence + permission probe. puterfs has no real permission bits (mode is
	// a constant 0o777), so R/W/X_OK always pass — only F_OK can fail, which the
	// stat below surfaces as ENOENT.
	async access(path, _mode?) {
		await this.stat(path);
	},
	async truncate(path, len) {
		path = normalizePath(path as any);
		len ??= 0;
		if (!Number.isInteger(len)) len = Math.trunc(len);
		if (len < 0) len = 0;

		let buf = (await this.readFile(path)) as Buffer;
		let out: Buffer;
		if (len <= buf.length) out = buf.subarray(0, len) as Buffer;
		else {
			out = Buffer.alloc(len);
			buf.copy(out, 0);
		}
		await this.writeFile(path, out);
	},
	async cp(source, destination, opts) {
		let options = (opts || {}) as any;
		let force = options.force !== false;
		let errorOnExist = options.errorOnExist || false;
		let recursive = options.recursive || false;
		let filter = options.filter as
			| ((s: string, d: string) => boolean | Promise<boolean>)
			| undefined;

		let self = this;
		async function copyEntry(src: string, dest: string): Promise<void> {
			if (filter && !(await filter(src, dest))) return;

			let srcStat = await self.stat(src);
			if (srcStat.isDirectory()) {
				if (!recursive)
					throw createFsError(
						"EISDIR",
						-21,
						"recursive option not enabled, cannot copy a directory",
						"cp",
						src
					);
				await self.mkdir(dest, { recursive: true });
				let entries = (await self.readdir(src)) as string[];
				for (let entry of entries)
					await copyEntry(
						nodePath.join(src, entry),
						nodePath.join(dest, entry)
					);
				return;
			}

			let destExists = false;
			try {
				await self.stat(dest);
				destExists = true;
			} catch {}
			if (destExists) {
				if (errorOnExist)
					throw createFsError("EEXIST", -17, "file already exists", "cp", dest);
				if (!force) return;
			}
			await self.copyFile(src, dest);
		}

		await copyEntry(
			normalizePath(source as any),
			normalizePath(destination as any)
		);
	},
	async mkdtemp(prefix, options?) {
		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		let path = normalizePath((prefix as any) + randomTempSuffix());
		await this.mkdir(path);

		let nameBuf = Buffer.from(path, "utf8");
		if ((options as any).encoding === "buffer") return nameBuf as any;
		return nameBuf.toString((options as any).encoding || undefined) as any;
	},
	async mkdtempDisposable(prefix, options?) {
		let path = (await (this.mkdtemp as any)(prefix, options)) as string;
		let self = this;
		let removed = false;
		let remove = async () => {
			if (removed) return;
			removed = true;
			await self.rm(path, { recursive: true, force: true });
		};
		return {
			path,
			remove,
			[Symbol.asyncDispose]: remove,
		} as any;
	},
	// puterfs has no mode/owner bits; validate existence then no-op.
	async chmod(path, _mode) {
		await this.stat(path);
	},
	async lchmod(path, _mode) {
		await this.stat(path);
	},
	async chown(path, _uid, _gid) {
		await this.stat(path);
	},
	async lchown(path, _uid, _gid) {
		await this.stat(path);
	},
};
