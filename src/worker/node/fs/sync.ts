import { decode, fetchPuterSync, getRandomId } from "../../puter";
import nodeBuffer from "../buffer";
import nodePath from "../path";
import { fsConstants, normalizePath, translatePuterError } from "./util";
import { Stats, StatsFs, Dirent, Dir } from "./classes";
import { promisesToDepromisify, promisesRemaining } from "./promises";
// @ts-ignore — upstream node JS, glob spec impl backed by minimatch
import { Glob } from "node-core:internal/fs/glob";

type NodeFs = typeof import("node:fs");

let Buffer = nodeBuffer.Buffer;

type OpenFlags = {
	create: boolean;
	truncateOnOpen: boolean;
	exclusive: boolean;
};

function createFsError(
	code: string,
	errno: number,
	message: string,
	syscall: string,
	path?: string
): NodeJS.ErrnoException & { code: string; errno: number } {
	const err = new Error(
		`${code}: ${message}, ${syscall}${path ? ` '${path}'` : ""}`
	) as NodeJS.ErrnoException & { code: string; errno: number };
	err.code = code;
	err.errno = errno;
	err.syscall = syscall;
	if (path) err.path = path;
	return err;
}

function parseOpenFlags(flags: string | number | undefined): OpenFlags {
	if (flags === undefined) flags = "r";

	if (typeof flags === "number") {
		throw createFsError(
			"EINVAL",
			-22,
			"numeric open flags are not supported",
			"open"
		);
	}

	const aliases: Record<string, string> = {
		rs: "r",
		"rs+": "r+",
		as: "a",
		"as+": "a+",
	};

	const normalized = aliases[flags] ?? flags;
	if (
		normalized === "r" ||
		normalized === "r+" ||
		normalized === "w" ||
		normalized === "w+" ||
		normalized === "wx" ||
		normalized === "wx+" ||
		normalized === "a" ||
		normalized === "a+" ||
		normalized === "ax" ||
		normalized === "ax+"
	) {
		return {
			create:
				normalized.startsWith("w") ||
				normalized.startsWith("a") ||
				normalized.startsWith("x"),
			truncateOnOpen: normalized.startsWith("w"),
			exclusive: normalized.includes("x"),
		};
	}

	throw createFsError("EINVAL", -22, "invalid flags", "open");
}

let nextFd = 10;

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

		if (options.mode) throw new Error("TODO");

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

		return new Stats(res, options.bigint || false);
	},
	// puter fs has no symlinks, so lstat is just stat.
	lstatSync(path, options?) {
		return this.statSync(path, options as any);
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
			form.append("file", new File([buf.buffer], name));
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
};
