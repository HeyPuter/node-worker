import { decode, fetchPuterSync, getRandomId } from "../puter";
import { buffer as nodeBuffer, path as nodePath } from "../node";
import { fsConstants, toPathString } from "./util";
import { Stats, StatsFs, Dirent, Dir } from "./classes";
import { promisesToDepromisify, promisesRemaining } from "./promises";

type NodeFs = typeof import("node:fs");

let Buffer = nodeBuffer.Buffer;

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
		else throw new Error("unreachable");

		this.writeFileSync(path, total, {
			flush: options.flush,
			mode: options.mode,
		});
	},
	copyFileSync(src, dest, mode) {
		src = toPathString(src);
		dest = toPathString(dest);

		mode ??= 0;
		let overwrite = (mode & fsConstants.COPYFILE_EXCL) === 0;

		if (mode & fsConstants.COPYFILE_FICLONE_FORCE)
			throw new Error("copy on write not supported");

		let destName = nodePath.basename(dest);
		let destDir = nodePath.dirname(dest);
		let [ok, u8array] = fetchPuterSync("copy", {
			source: src,
			destination: destDir,
			new_name: destName,
			overwrite,
			dedupe_name: false,
		});

		if (!ok) throw new Error(decode(u8array).message);
	},
	mkdirSync(path, options) {
		path = toPathString(path);

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

		if (!ok) throw new Error(res.message);

		/*
		if (recursive)
			// TODO it's supposed to parent_directories_created based on puter oss but it's not that and it's also broken
			// this also doesn't handle if the target directory was created
			return res.parent_dirs_created[0];
			*/
	},
	opendirSync(path, options) {
		path = toPathString(path);

		let entries = this.readdirSync(path, {
			withFileTypes: true,
			recursive: options?.recursive,
			encoding: options?.encoding,
		}) as InstanceType<typeof Dirent>[];
		return new Dir(path, entries);
	},
	readdirSync(path, options) {
		path = toPathString(path);

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
			if (!ok) throw new Error((res as any).message);

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
		path = toPathString(path);

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?
		let [ok, u8array] = fetchPuterSync(
			`read?file=${encodeURIComponent(path)}`,
			undefined
		);

		if (!ok) throw new Error(decode(u8array).message);

		let buf = Buffer.from(u8array);
		if (options.encoding)
			// not sure why ts doesn't like this
			return buf.toString(options.encoding) as any;
		else return buf;
	},
	renameSync(oldPath, newPath) {
		oldPath = toPathString(oldPath);
		newPath = toPathString(newPath);

		let newName = nodePath.basename(newPath);
		let newDir = nodePath.dirname(newPath);
		let [ok, u8array] = fetchPuterSync("move", {
			source: oldPath,
			destination: newDir,
			new_name: newName,
			overwrite: false,
			create_missing_parents: false,
		});
		if (!ok) throw new Error(decode(u8array).message);
	},
	rmdirSync(path) {
		return this.unlinkSync(path);
	},
	rmSync(path, options) {
		// TODO retries?
		path = toPathString(path);

		if (!options) options = {};

		let [ok, u8array] = fetchPuterSync("delete", {
			paths: [path],
			recursive: options.recursive || false,
			descendants_only: false,
		});
		if (!options.force && !ok) throw new Error(decode(u8array).message);
	},
	statSync(path, options) {
		path = toPathString(path);
		if (!options) options = {};

		let [ok, u8array] = fetchPuterSync("stat", {
			path,
			return_size: true,
			return_permissions: false,
			return_versions: false,
			consistency: "strong",
		});
		let res = decode(u8array);

		if (!ok) throw new Error(res.message);

		return new Stats(res, options.bigint || false);
	},
	statfsSync(_path, options) {
		// ignore path, this is puterfs
		if (!options) options = {};

		let [ok, u8array] = fetchPuterSync("df", {});
		let res = decode(u8array);

		if (!ok) throw new Error(res.message);

		return new StatsFs(res, options.bigint || false);
	},
	writeFileSync(file, data, options) {
		file = toPathString(file);

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
		if (result.success === false) throw new Error(result.message);
	},
	unlinkSync(path) {
		path = toPathString(path);

		let [ok, u8array] = fetchPuterSync("delete", {
			paths: [path],
			recursive: false,
			descendants_only: false,
		});
		if (!ok) throw new Error(decode(u8array).message);
	},
};
