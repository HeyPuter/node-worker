import nodeBuffer from "../buffer";
import nodePath from "../path";
import { bigintDivideAway } from "./util";

type NodeFs = typeof import("node:fs");

let Buffer = nodeBuffer.Buffer;

// node's typings declare these four classes with `private constructor()`. We
// can't satisfy that nominally, so each export is typed as
// `NodeFs[X] & { new(...args): any }`: instance shape and statics flow
// through from node's typing (`Pick<T, keyof T>` is `T`), and the extra
// constructor signature carries our internal puter-shaped construction.
export let StatsFs: Pick<NodeFs["StatsFs"], keyof NodeFs["StatsFs"]> & {
	new (puterStats: any, bigint: boolean): any;
} = class StatsFs<T extends number | bigint = number> {
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

export let Stats: Pick<NodeFs["Stats"], keyof NodeFs["Stats"]> & {
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

export let Dirent: Pick<NodeFs["Dirent"], keyof NodeFs["Dirent"]> & {
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

export let Dir: Pick<NodeFs["Dir"], keyof NodeFs["Dir"]> & {
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
