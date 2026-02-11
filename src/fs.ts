import { decode, fetchPuter, getRandomId } from "./puter";
import { buffer as nodeBuffer, stream as nodeStream, path as nodePath, streamToBuffer, depromisify } from "./node";
let Buffer = nodeBuffer.Buffer;
let streamReadable = nodeStream.Readable;

type NodeFs = typeof import("node:fs");

type NodeFsPromises = NodeFs["promises"];

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
	async readFile(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?
		let [ok, u8array] = await fetchPuter(`read?file=${encodeURIComponent(path)}`, options.signal);

		if (!ok) throw new Error(decode(u8array).message);

		let buf = Buffer.from(u8array);
		if (options.encoding)
			// not sure why ts doesn't like this
			return buf.toString(options.encoding) as any;
		else
			return buf;
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

		let [_ok, u8array] = await fetchPuter("batch", options.signal, (form) => {
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
		});
		let res = decode(u8array);

		let result = res.results[0];
		if (result.success === false) throw new Error(result.message);
	},
	async mkdir(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		if (typeof options === "number" || typeof options === "string") options = { mode: options };
		else if (!options) options = {};

		if (options.mode) throw new Error("TODO");

		let recursive = options.recursive || false;
		let dirName = nodePath.basename(path);
		let dirPath = nodePath.dirname(path);
		let [ok, u8array] = await fetchPuter("mkdir", undefined, {
			parent: dirPath,
			path: dirName,
			overwrite: recursive,
			dedupe_name: false,
			create_missing_parents: recursive,
		});
		let res = decode(u8array);

		if (!ok) throw new Error(res.message);

		if (recursive)
			return res.parent_directories_created[0];
	},
	async readdir(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		if (typeof options === "string") options = { encoding: options } as {};
		else if (!options) options = {};

		let children: any[][] = [];

		let stack: string[] = [path];
		let currentPath: string | undefined;

		while (currentPath = stack.pop()) {
			let [ok, u8array] = await fetchPuter("readdir", undefined, {
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
	async rename(oldPath, newPath) {
		if (typeof oldPath !== "string") throw new Error("TODO");
		if (typeof newPath !== "string") throw new Error("TODO");

		let newName = nodePath.basename(newPath);
		let newDir = nodePath.dirname(newPath);
		let [ok, u8array] = await fetchPuter("move", undefined, {
			source: oldPath,
			destination: newDir,
			new_name: newName,
			overwrite: false,
			create_missing_parents: false,
		});
		if (!ok) throw new Error(decode(u8array).message);
	},
	async unlink(path) {
		if (typeof path !== "string") throw new Error("TODO");

		let [ok, u8array] = await fetchPuter("delete", undefined, {
			paths: [path],
			recursive: false,
			descendants_only: false,
		})
		if (!ok) throw new Error(decode(u8array).message);
	},
	async rmdir(path) {
		return await this.unlink(path);
	},
	async rm(path, options) {
		// TODO retries?
		if (typeof path !== "string") throw new Error("TODO");

		if (!options) options = {};

		let [ok, u8array] = await fetchPuter("delete", undefined, {
			paths: [path],
			recursive: options.recursive || false,
			descendants_only: false,
		})
		if (!options.force && !ok) throw new Error(decode(u8array).message);
	}
};
let promisesRemaining: Pick<NodeFsPromises, "watch" | "glob" | "constants"> = {};
let promises: NodeFsPromises = {} as any;
Object.assign(promises, promisesToDepromisify, promisesRemaining);

export default {
	Dirent: Dirent as any,
	promises, 
	...(depromisify(promisesToDepromisify))
} satisfies typeof import("node:fs");

/*
function init_puter_portable(auth) {

	// For form or no body
	const headers = {
		"Authorization": auth
	}

	// For a JSON body
	const headersAndJSON = {
		"Authorization": auth,
		"content-type": "application/json;charset=UTF-8"
	}

	globalThis.puter_pp = {
		fs: {
			read: (path) => {
				return fetch("https://api.puter.com/read?file=" + encodeURIComponent(path), { headers }).then(res => res.blob())
			},
			write: (path, data, options) => {
				const operation_id = crypto.randomUUID(); // SECURE CONTEXTS ONLY, wont work over http

				// Path parsing
				let directory = path.split("/");
				const fileName = directory.pop();
				directory = directory.join("/");

				if (data instanceof File) {
					// Passthrough
				} else if (typeof (data) === "string") {
					data = new File([data], fileName);
				} else if ((data instanceof Blob) && !(data instanceof File)) {
					data = new File([data], fileName);
				}

				if (!options)
					options = {};

				const operationInfo = {
					"op": "write",
					"dedupe_name": options.dedupeName || options.dedupe_name || false,
					"overwrite": options.overwrite ? true : false,
					"operation_id": operation_id,
					"path": directory,
					"name": fileName,
					"item_upload_id": 0
				};

				// Replicate request exactly as puter.fs.write minus socket_id
				const writeBatchData = new FormData();
				writeBatchData.append("operation_id", operation_id);
				writeBatchData.append("fileinfo", JSON.stringify({ name: fileName, type: "application/octet-stream", size: data.size }));
				writeBatchData.append("operation", JSON.stringify(operationInfo));
				writeBatchData.append("file", data);
				return fetch("https://api.puter.com/batch", { method: "POST", body: writeBatchData, headers })
			},
			copy: (source, destination, options) => {
				if (!options) {
					options = {};
				}

				passed_options = {
					source,
					destination,
					overwrite: options.overwrite || undefined,
					dedupe_name: options.dedupe_name || options.dedupeName || undefined,
					create_missing_parents: options.create_missing_parents || options.createMissingParents || undefined,
					new_name: options.new_name || options.new_name || undefined
				}

				return fetch("https://api.puter.com/copy", { method: "POST", body: JSON.stringify(passed_options), headers: headersAndJSON })

			},
			readdir: (path) => {
				return fetch("https://api.puter.com/readdir", { method: "POST", body: JSON.stringify({ path }), headers: headersAndJSON }).then(res => res.json())
			},
			stat: (path) => {
				return fetch("https://api.puter.com/stat", { method: "POST", body: JSON.stringify({ path }), headers: headersAndJSON }).then(res => res.json())
			},
			mkdir: (path, options) => {
				if (!options) {
					options = {}
				}

				let parent = path.split("/");
				const newDir = parent.pop();
				parent = parent.join("/");

				passed_options = {
					parent,
					path: newDir,
					overwrite: options.overwrite || false,
					dedupe_name: options.dedupe_name || options.dedupeName || false,
					create_missing_parents: options.create_missing_parents || options.createMissingParents || false
				}

				return fetch("https://api.puter.com/mkdir", { method: "POST", body: JSON.stringify(passed_options), headers: headersAndJSON }).then(res => res.json())
			},
			rename: (path, new_name) => {
				return fetch("https://api.puter.com/rename", { method: "POST", body: JSON.stringify({ path, new_name }), headers: headersAndJSON }).then(res => res.json())
			},
			move: (source, destinationPath, options) => {
				if (!options) {
					options = {}
				}
				// Normalize
				if (destinationPath.endsWith("/")) {
					destinationPath = destinationPath.slice(0, -1)
				}

				let destination = destinationPath.split("/");
				const new_name = destination.pop();
				destination = destination.join("/");

				passed_options = {
					destination,
					source,
					new_name,
					overwrite: options.overwrite || undefined,
					dedupe_name: options.dedupe_name || options.dedupeName || undefined,
					create_missing_parents: options.create_missing_parents || options.createMissingParents || undefined
				}

				return fetch("https://api.puter.com/move", { method: "POST", body: JSON.stringify(passed_options), headers: headersAndJSON }).then(res => res.json())
			},

		}
	}
}
*/
