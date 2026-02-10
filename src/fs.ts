import { fetchPuter, getRandomId } from "./puter";
import { buffer as nodeBuffer, stream as nodeStream, path as nodePath, streamToBuffer, depromisify } from "./node";
let Buffer = nodeBuffer.Buffer;
let streamReadable = nodeStream.Readable;

type NodeFsPromises = typeof import("node:fs").promises;

let promisesToDepromisify: Omit<NodeFsPromises, "watch" | "glob" | "constants"> = {
	async readFile(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?
		let arraybuf = await fetchPuter(`read?file=${encodeURIComponent(path)}`, options.signal).then(r => r.arrayBuffer());
		let buf = Buffer.from(arraybuf);

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

		let fileName = nodePath.basename(file);
		let filePath = nodePath.dirname(file);

		let res = await fetchPuter(`batch`, options.signal, (form) => {
			let opId = getRandomId();
			form.append("operation_id", opId);
			form.append("fileinfo", JSON.stringify({ name: fileName, type: "application/octet-stream", size: buf.byteLength }));
			form.append("operation", JSON.stringify({
				operation_id: opId,

				op: "write",
				path: filePath + "/",
				name: fileName,
				item_upload_id: 0,
				overwrite: true,
				dedupe_name: false,
			}));
			form.append("file", new File([buf.buffer], fileName));
		}).then(r=>r.json());

		let result = res.results[0];

		if (result.status !== 200) throw new Error(result.message);
	}
};
let promisesRemaining: Pick<NodeFsPromises, "watch" | "glob" | "constants"> = {};
let promises: NodeFsPromises = {} as any;
Object.assign(promises, promisesToDepromisify, promisesRemaining);

export default {
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
