import { decode, fetchPuter, fetchPuterSync, getRandomId } from "./puter";
import {
	buffer as nodeBuffer,
	stream as nodeStream,
	path as nodePath,
	streamToBuffer,
	depromisify,
} from "./node";
import { StatsBase as Stats } from "node:fs";
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
	COPYFILE_FICLONE_FORCE: 4,
};

let bigintDivideAway = (a: bigint, b: bigint) =>
	a / b + (a % b === 0n ? 0n : a > 0n === b > 0n ? 1n : -1n);

let StatsFs: Pick<NodeFs["StatsFs"], keyof NodeFs["StatsFs"]> & {
	new (puterStats: any, bigint: boolean): any;
} = class Stats<T extends number | bigint = number> {
	#bigint: boolean;
	#used: T;
	#total: T;

	constructor(puterStats: any, bigint: boolean) {
		this.#bigint = bigint;
		if (bigint) {
			this.#used = BigInt(puterStats.used) as any;
			this.#total = BigInt(puterStats.capacity) as any;
		} else {
			this.#used = puterStats.used as any;
			this.#total = puterStats.capacity as any;
		}
	}

	// @internal
	get _avail(): T {
		return (this.#total - this.#used) as any;
	}

	get type(): T {
		// fusefs_super_magic
		return this.#bigint ? (0x65735546n as any) : (0x65735546 as any);
	}

	get bsize(): T {
		return this.#bigint ? (4096n as any) : (4096 as any);
	}
	get blocks(): T {
		if (this.#bigint) {
			return bigintDivideAway(this.#total as any, this.bsize as any) as any;
		} else {
			return Math.ceil(this.#total / this.bsize) as any;
		}
	}
	get bfree(): T {
		if (this.#bigint) {
			return bigintDivideAway(this._avail as any, this.bsize as any) as any;
		} else {
			return Math.ceil(this._avail / this.bsize) as any;
		}
	}
	get bavail(): T {
		return this.bfree;
	}

	get files(): T {
		return this.#bigint ? (1024n as any) : (1024 as any);
	}
	get ffree(): T {
		return this.#bigint ? (1024n as any) : (1024 as any);
	}
};

let Stats: Pick<NodeFs["Stats"], keyof NodeFs["Stats"]> & {
	new (puterStats: any, bigint: boolean): any;
} = class Stats<T extends number | bigint = number> {
	#bigint: boolean;
	#size: T;
	#ctime: T;
	#mtime: T;
	#isSymlink: boolean;
	#isDir: boolean;

	constructor(puterStats: any, bigint: boolean) {
		this.#isSymlink = puterStats.is_symlink;
		this.#isDir = puterStats.is_dir;

		this.#bigint = bigint;
		if (bigint) {
			this.#ctime = BigInt(new Date(puterStats.created_at).getTime()) as any;
			this.#mtime = BigInt(new Date(puterStats.updated_at).getTime()) as any;
			this.#size = BigInt(puterStats.size) as any;
		} else {
			this.#ctime = new Date(puterStats.created_at).getTime() as any;
			this.#mtime = new Date(puterStats.updated_at).getTime() as any;
			this.#size = puterStats.size as any;
		}
	}

	isFile() {
		return !this.#isDir;
	}
	isDirectory() {
		return this.#isDir;
	}
	isBlockDevice() {
		return false;
	}
	isCharacterDevice() {
		return false;
	}
	isFIFO() {
		return false;
	}
	isSocket() {
		return false;
	}
	isSymbolicLink() {
		return this.#isSymlink;
	}

	get dev(): T {
		return this.#bigint ? (0n as any) : (0 as any);
	}
	get ino(): T {
		return this.#bigint ? (0n as any) : (0 as any);
	}
	get mode(): T {
		return this.#bigint ? (0o777n as any) : (0o777 as any);
	}
	get nlink(): T {
		return this.#bigint ? (0n as any) : (0 as any);
	}
	get uid(): T {
		return this.#bigint ? (0n as any) : (0 as any);
	}
	get gid(): T {
		return this.#bigint ? (0n as any) : (0 as any);
	}
	get rdev(): T {
		return this.#bigint ? (0n as any) : (0 as any);
	}
	get size(): T {
		return this.#size;
	}
	get blksize(): T {
		return this.#bigint ? (4096n as any) : (4096 as any);
	}
	get blocks(): T {
		if (this.#bigint) {
			return bigintDivideAway(this.size as any, this.blksize as any) as any;
		} else {
			return Math.ceil(this.size / this.blksize) as any;
		}
	}

	get atimeMs(): T {
		return this.#mtime;
	}
	get atimeNs(): T {
		return (this.#mtime * ((this.#bigint ? 1000000n : 1000000) as any)) as any;
	}
	get ctimeMs(): T {
		return this.#ctime;
	}
	get ctimeNs(): T {
		return (this.#ctime * ((this.#bigint ? 1000000n : 1000000) as any)) as any;
	}
	get birthtimeMs(): T {
		return this.#ctime;
	}
	get birthtimeNs(): T {
		return (this.#ctime * ((this.#bigint ? 1000000n : 1000000) as any)) as any;
	}
	get mtimeMs(): T {
		return this.#mtime;
	}
	get mtimeNs(): T {
		return (this.#mtime * ((this.#bigint ? 1000000n : 1000000) as any)) as any;
	}

	get atime(): Date {
		return new Date(+("" + this.atimeMs));
	}
	get ctime(): Date {
		return new Date(+("" + this.ctimeMs));
	}
	get mtime(): Date {
		return new Date(+("" + this.mtimeMs));
	}
	get birthtime(): Date {
		return new Date(+("" + this.birthtimeMs));
	}
};

let Dirent: Pick<NodeFs["Dirent"], keyof NodeFs["Dirent"]> & {
	new (name: string | Buffer, puterStats: any): any;
} = class Dirent {
	#isDir: boolean;
	#isSymlink: boolean;
	#name: string | Buffer;
	#parentPath: string;

	constructor(name: string | Buffer, puterStats: any) {
		this.#isSymlink = puterStats.is_symlink;
		this.#isDir = puterStats.is_dir;
		this.#name = name;
		this.#parentPath = nodePath.basename(nodePath.dirname(puterStats.path));
	}

	isFile() {
		return !this.#isDir;
	}
	isDirectory() {
		return this.#isDir;
	}
	isBlockDevice() {
		return false;
	}
	isCharacterDevice() {
		return false;
	}
	isFIFO() {
		return false;
	}
	isSocket() {
		return false;
	}
	isSymbolicLink() {
		return this.#isSymlink;
	}

	get name() {
		return this.#name;
	}
	get parentPath() {
		return this.#parentPath;
	}
};

let Dir: Pick<NodeFs["Dir"], keyof NodeFs["Dir"]> & {
	new (path: string, entries: InstanceType<typeof Dirent>[]): any;
} = class Dir {
	#path: string;
	#entries: InstanceType<typeof Dirent>[];
	#index: number;
	#closed: boolean;

	constructor(path: string, entries: InstanceType<typeof Dirent>[]) {
		this.#path = path;
		this.#entries = entries;
		this.#index = 0;
		this.#closed = false;
	}

	get path(): string {
		return this.#path;
	}

	readSync(): InstanceType<typeof Dirent> | null {
		if (this.#closed) throw new Error("Directory handle was closed");
		if (this.#index >= this.#entries.length) return null;
		return this.#entries[this.#index++];
	}

	async read(): Promise<InstanceType<typeof Dirent> | null> {
		return this.readSync();
	}

	closeSync(): void {
		if (this.#closed) throw new Error("Directory handle was closed");
		this.#closed = true;
	}

	async close(): Promise<void> {
		this.closeSync();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<
		InstanceType<typeof Dirent>,
		undefined
	> {
		let entry;
		while ((entry = this.readSync()) !== null) {
			yield entry;
		}
		if (!this.#closed) this.closeSync();
		return undefined;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.#closed) await this.close();
	}

	[Symbol.dispose](): void {
		if (!this.#closed) this.closeSync();
	}
};

let promisesToDepromisify: Omit<
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
		else throw new Error("unreachable");

		await this.writeFile(path, total, {
			flush: options.flush,
			mode: options.mode,
		});
	},
	async copyFile(src, dest, mode) {
		if (typeof src !== "string") throw new Error("TODO");
		if (typeof dest !== "string") throw new Error("TODO");

		mode ??= 0;
		let overwrite = (mode & fsConstants.COPYFILE_EXCL) === 0;

		if (mode & fsConstants.COPYFILE_FICLONE_FORCE)
			throw new Error("copy on write not supported");

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

		if (typeof options === "number" || typeof options === "string")
			options = { mode: options };
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
	async opendir(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		let entries = (await this.readdir(path, {
			withFileTypes: true,
			recursive: options?.recursive,
			encoding: options?.encoding,
		})) as InstanceType<typeof Dirent>[];
		return new Dir(path, entries);
	},
	async readdir(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

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
	async readFile(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?
		let [ok, u8array] = await fetchPuter(
			`read?file=${encodeURIComponent(path)}`,
			undefined,
			options.signal
		);

		if (!ok) throw new Error(decode(u8array).message);

		let buf = Buffer.from(u8array);
		if (options.encoding)
			// not sure why ts doesn't like this
			return buf.toString(options.encoding) as any;
		else return buf;
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
		});
		if (!options.force && !ok) throw new Error(decode(u8array).message);
	},
	async stat(path, options) {
		if (typeof path !== "string") throw new Error("TODO");
		if (!options) options = {};

		let [ok, u8array] = await fetchPuter("stat", {
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
	async statfs(_path, options) {
		// ignore path, this is puterfs
		if (!options) options = {};

		let [ok, u8array] = await fetchPuter("df", {});
		let res = decode(u8array);

		if (!ok) throw new Error(res.message);

		return new StatsFs(res, options.bigint || false);
	},
	async writeFile(file, data, options) {
		if (typeof file !== "string") throw new Error("TODO");

		if (typeof options === "string") options = { encoding: options };
		else if (!options) options = {};

		// options.flag doesn't do anything?

		let buf;
		if (typeof data === "string")
			buf = Buffer.from(data, options.encoding || undefined);
		else if (data instanceof Buffer) buf = data;
		else if (data instanceof DataView) buf = Buffer.from(data.buffer);
		else if (data instanceof streamReadable) buf = await streamToBuffer(data);
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
				form.append("file", new File([buf.buffer], name));
			},
			options.signal
		);
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
		});
		if (!ok) throw new Error(decode(u8array).message);
	},
};
let promisesRemaining: Pick<NodeFsPromises, "watch" | "glob" | "constants"> = {
	constants: { ...fsConstants },
};
let promises: NodeFsPromises = {} as any;
Object.assign(promises, promisesToDepromisify, promisesRemaining);

let fsSync: Omit<
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
		if (typeof src !== "string") throw new Error("TODO");
		if (typeof dest !== "string") throw new Error("TODO");

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
		if (typeof path !== "string") throw new Error("TODO");

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
		if (typeof path !== "string") throw new Error("TODO");

		let entries = this.readdirSync(path, {
			withFileTypes: true,
			recursive: options?.recursive,
			encoding: options?.encoding,
		}) as InstanceType<typeof Dirent>[];
		return new Dir(path, entries);
	},
	readdirSync(path, options) {
		if (typeof path !== "string") throw new Error("TODO");

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
		if (typeof path !== "string") throw new Error("TODO");

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
		if (typeof oldPath !== "string") throw new Error("TODO");
		if (typeof newPath !== "string") throw new Error("TODO");

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
		if (typeof path !== "string") throw new Error("TODO");

		if (!options) options = {};

		let [ok, u8array] = fetchPuterSync("delete", {
			paths: [path],
			recursive: options.recursive || false,
			descendants_only: false,
		});
		if (!options.force && !ok) throw new Error(decode(u8array).message);
	},
	statSync(path, options) {
		if (typeof path !== "string") throw new Error("TODO");
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
		if (typeof file !== "string") throw new Error("TODO");

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
		if (typeof path !== "string") throw new Error("TODO");

		let [ok, u8array] = fetchPuterSync("delete", {
			paths: [path],
			recursive: false,
			descendants_only: false,
		});
		if (!ok) throw new Error(decode(u8array).message);
	},
};

export default {
	Dir: Dir as any,
	Dirent: Dirent as any,
	Stats: Stats as any,
	StatsFs: StatsFs as any,
	constants: fsConstants,
	promises,
	...fsSync,
	...depromisify(promisesToDepromisify),
} satisfies typeof import("node:fs");
