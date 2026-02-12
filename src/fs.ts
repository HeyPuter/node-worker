import { decode, fetchPuter, getRandomId } from "./puter";
import { buffer as nodeBuffer, stream as nodeStream, path as nodePath, streamToBuffer, depromisify } from "./node";
let Buffer = nodeBuffer.Buffer;
let streamReadable = nodeStream.Readable;

type NodeFs = typeof import("node:fs");

type NodeFsPromises = NodeFs["promises"];

let fsConstants: NodeFs["constants"] = {
	O_RDONLY: 0,
	O_WRONLY: 1,
	O_RDWR: 2,
	S_IFMT: 61440,
	S_IFREG: 32768,
	S_IFDIR: 16384,
	S_IFCHR: 8192,
	S_IFBLK: 24576,
	S_IFIFO: 4096,
	S_IFLNK: 40960,
	S_IFSOCK: 49152,
	O_CREAT: 64,
	O_EXCL: 128,
	UV_FS_O_FILEMAP: 0,
	O_NOCTTY: 256,
	O_TRUNC: 512,
	O_APPEND: 1024,
	O_DIRECTORY: 65536,
	O_NOATIME: 262144,
	O_NOFOLLOW: 131072,
	O_SYMLINK: 2097152, // macos only
	O_SYNC: 1052672,
	O_DSYNC: 4096,
	O_DIRECT: 16384,
	O_NONBLOCK: 2048,
	S_IRWXU: 448,
	S_IRUSR: 256,
	S_IWUSR: 128,
	S_IXUSR: 64,
	S_IRWXG: 56,
	S_IRGRP: 32,
	S_IWGRP: 16,
	S_IXGRP: 8,
	S_IRWXO: 7,
	S_IROTH: 4,
	S_IWOTH: 2,
	S_IXOTH: 1,
	F_OK: 0,
	R_OK: 4,
	W_OK: 2,
	X_OK: 1,
	COPYFILE_EXCL: 1,
	COPYFILE_FICLONE: 2,
	COPYFILE_FICLONE_FORCE: 4
};

let Dirent: Pick<NodeFs["Dirent"], keyof NodeFs["Dirent"]> & {
	new(isSymlink: boolean, isDir: boolean, name: string | Buffer, parentPath: string): any;
} = class Dirent {
		#isDir: boolean;
		#isSymlink: boolean;
		#name: string | Buffer;
		#parentPath: string;

		constructor(isSymlink: boolean, isDir: boolean, name: string | Buffer, parentPath: string) {
			this.#isSymlink = isSymlink;
			this.#isDir = isDir;
			this.#name = name;
			this.#parentPath = parentPath;
		}

		isFile() {
			return !this.#isDir;
		}
		isDirectory() {
			return this.#isDir;
		}
		isBlockDevice() { return false; }
		isCharacterDevice() { return false; }
		isFIFO() { return false; }
		isSocket() { return false; }
		isSymbolicLink() { return this.#isSymlink; }

		get name() {
			return this.#name;
		}
		get parentPath() {
			return this.#parentPath;
		}
	}

let promisesToDepromisify: Omit<NodeFsPromises, "watch" | "glob" | "constants"> = {
	async copyFile(src, dest, mode) {
		if (typeof src !== "string") throw new Error("TODO");
		if (typeof dest !== "string") throw new Error("TODO");

		mode ??= 0;
		let overwrite = (mode & fsConstants.COPYFILE_EXCL) === 0;

		if (mode & fsConstants.COPYFILE_FICLONE_FORCE) throw new Error("copy on write not supported");

		let destName = nodePath.basename(dest);
		let destDir = nodePath.dirname(dest);
		let [ok, u8array] = await fetchPuter("copy", {
			source: src,
			destination: destDir,
			new_name: destName,
			overwrite,
			dedupe_name: false,
		});

		if (!ok) throw new Error(decode(u8array).message);
	},
	async mkdir(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		if (typeof options === "number" || typeof options === "string") options = { mode: options };
		else if (!options) options = {};

		if (options.mode) throw new Error("TODO");

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

		if (!ok) throw new Error(res.message);

		if (recursive)
			// TODO it's supposed to parent_directories_created based on puter oss but it's not that and it's also broken
			// this also doesn't handle if the target directory was created
			return res.parent_dirs_created[0];
	},
	async readdir(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		if (typeof options === "string") options = { encoding: options } as {};
		else if (!options) options = {};

		let children: any[][] = [];

		let stack: string[] = [path];
		let currentPath: string | undefined;

		while (currentPath = stack.pop()) {
			let [ok, u8array] = await fetchPuter("readdir", {
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
			else
				name = nameBuf;

			if (options.withFileTypes) {
				return new Dirent(x.is_symlink, x.is_dir, name, nodePath.basename(nodePath.dirname(x.path)));
			} else {
				return name;
			}
		})
	},
	async readFile(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?
		let [ok, u8array] = await fetchPuter(`read?file=${encodeURIComponent(path)}`, undefined, options.signal);

		if (!ok) throw new Error(decode(u8array).message);

		let buf = Buffer.from(u8array);
		if (options.encoding)
			// not sure why ts doesn't like this
			return buf.toString(options.encoding) as any;
		else
			return buf;
	},
	async rename(oldPath, newPath) {
		if (typeof oldPath !== "string") throw new Error("TODO");
		if (typeof newPath !== "string") throw new Error("TODO");

		let newName = nodePath.basename(newPath);
		let newDir = nodePath.dirname(newPath);
		let [ok, u8array] = await fetchPuter("move", {
			source: oldPath,
			destination: newDir,
			new_name: newName,
			overwrite: false,
			create_missing_parents: false,
		});
		if (!ok) throw new Error(decode(u8array).message);
	},
	async rmdir(path) {
		return await this.unlink(path);
	},
	async rm(path, options) {
		// TODO retries?
		if (typeof path !== "string") throw new Error("TODO");

		if (!options) options = {};

		let [ok, u8array] = await fetchPuter("delete", {
			paths: [path],
			recursive: options.recursive || false,
			descendants_only: false,
		})
		if (!options.force && !ok) throw new Error(decode(u8array).message);
	},
	async writeFile(file, data, options) {
		if (typeof file !== "string") throw new Error("TODO");

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?

		let buf;
		if (typeof data === "string") buf = Buffer.from(data, options.encoding || undefined);
		else if (data instanceof Buffer) buf = data;
		else if (data instanceof DataView) buf = Buffer.from(data.buffer);
		else if (data instanceof streamReadable) buf = await streamToBuffer(data);
		else if ("buffer" in data) buf = Buffer.from(data.buffer);
		else throw new Error("TODO");

		let name = nodePath.basename(file);
		let path = nodePath.dirname(file);

		let [_ok, u8array] = await fetchPuter("batch", (form) => {
			let opId = getRandomId();
			form.append("operation_id", opId);
			form.append("fileinfo", JSON.stringify({ name, type: "application/octet-stream", size: buf.byteLength }));
			form.append("operation", JSON.stringify({
				op: "write",
				dedupe_name: false,
				overwrite: true,
				operation_id: opId,
				path,
				name,
				item_upload_id: 0,
			}));
			form.append("file", new File([buf.buffer], name));
		}, options.signal);
		let res = decode(u8array);

		let result = res.results[0];
		if (result.success === false) throw new Error(result.message);
	},
	async unlink(path) {
		if (typeof path !== "string") throw new Error("TODO");

		let [ok, u8array] = await fetchPuter("delete", {
			paths: [path],
			recursive: false,
			descendants_only: false,
		})
		if (!ok) throw new Error(decode(u8array).message);
	},
};
let promisesRemaining: Pick<NodeFsPromises, "watch" | "glob" | "constants"> = { constants: { ...fsConstants } };
let promises: NodeFsPromises = {} as any;
Object.assign(promises, promisesToDepromisify, promisesRemaining);

export default {
	Dirent: Dirent as any,
	constants: fsConstants,
	promises,
	...(depromisify(promisesToDepromisify))
} satisfies typeof import("node:fs");
