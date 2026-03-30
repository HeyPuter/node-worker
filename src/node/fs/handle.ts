import { decode, fetchPuter, getRandomId } from "../../puter";
import { buffer as nodeBuffer, path as nodePath } from "../polyfills";
import { Stats } from "./classes";
import { normalizePath, translatePuterError } from "./util";

// vibe coded part

let Buffer = nodeBuffer.Buffer;

type OpenFlags = {
	flag: string;
	read: boolean;
	write: boolean;
	append: boolean;
	create: boolean;
	truncateOnOpen: boolean;
	exclusive: boolean;
};

type Fragment = {
	start: number;
	end: number;
	data: Buffer;
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

	const table: Record<string, OpenFlags> = {
		r: {
			flag: "r",
			read: true,
			write: false,
			append: false,
			create: false,
			truncateOnOpen: false,
			exclusive: false,
		},
		"r+": {
			flag: "r+",
			read: true,
			write: true,
			append: false,
			create: false,
			truncateOnOpen: false,
			exclusive: false,
		},
		w: {
			flag: "w",
			read: false,
			write: true,
			append: false,
			create: true,
			truncateOnOpen: true,
			exclusive: false,
		},
		"w+": {
			flag: "w+",
			read: true,
			write: true,
			append: false,
			create: true,
			truncateOnOpen: true,
			exclusive: false,
		},
		wx: {
			flag: "wx",
			read: false,
			write: true,
			append: false,
			create: true,
			truncateOnOpen: true,
			exclusive: true,
		},
		"wx+": {
			flag: "wx+",
			read: true,
			write: true,
			append: false,
			create: true,
			truncateOnOpen: true,
			exclusive: true,
		},
		a: {
			flag: "a",
			read: false,
			write: true,
			append: true,
			create: true,
			truncateOnOpen: false,
			exclusive: false,
		},
		"a+": {
			flag: "a+",
			read: true,
			write: true,
			append: true,
			create: true,
			truncateOnOpen: false,
			exclusive: false,
		},
		ax: {
			flag: "ax",
			read: false,
			write: true,
			append: true,
			create: true,
			truncateOnOpen: false,
			exclusive: true,
		},
		"ax+": {
			flag: "ax+",
			read: true,
			write: true,
			append: true,
			create: true,
			truncateOnOpen: false,
			exclusive: true,
		},
	};

	const parsed = table[normalized];
	if (!parsed) {
		throw createFsError("EINVAL", -22, "invalid flags", "open");
	}

	return parsed;
}

function statMtimeMs(stat: any): number {
	return new Date(stat.updated_at).getTime();
}

async function statRaw(path: string): Promise<any> {
	const [ok, u8array] = await fetchPuter("stat", {
		path,
		return_size: true,
		return_permissions: false,
		return_versions: false,
		consistency: "strong",
	});
	const res = decode(u8array);
	if (!ok) {
		throw translatePuterError(res.code, "stat", path) ?? new Error(res.message);
	}
	return res;
}

async function readWholeFile(path: string): Promise<Buffer> {
	const [ok, u8array] = await fetchPuter(
		`read?file=${encodeURIComponent(path)}`
	);
	if (!ok) {
		const res = decode(u8array);
		throw translatePuterError(res.code, "open", path) ?? new Error(res.message);
	}
	return Buffer.from(u8array);
}

async function readRange(
	path: string,
	offset: number,
	byteCount: number
): Promise<Buffer> {
	const [ok, u8array] = await fetchPuter(
		`read?file=${encodeURIComponent(path)}&offset=${offset}&byte_count=${byteCount}`
	);
	if (!ok) {
		const res = decode(u8array);
		throw translatePuterError(res.code, "read", path) ?? new Error(res.message);
	}
	return Buffer.from(u8array);
}

async function writeWholeFile(path: string, buf: Buffer): Promise<void> {
	const name = nodePath.basename(path);
	const parent = nodePath.dirname(path);
	const [_ok, u8array] = await fetchPuter("batch", (form) => {
		const opId = getRandomId();
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
				path: parent,
				name,
				item_upload_id: 0,
			})
		);
		form.append("file", new File([buf as unknown as BlobPart], name));
	});
	const res = decode(u8array);
	const result = res.results[0];
	if (result.success === false) {
		throw (
			translatePuterError(result.code, "write", path) ??
			new Error(result.message)
		);
	}
}

function toBufferValue(
	data: string | NodeJS.ArrayBufferView | ArrayBuffer,
	encoding?: BufferEncoding
): Buffer {
	if (typeof data === "string") return Buffer.from(data, encoding);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	}
	throw createFsError("EINVAL", -22, "invalid argument", "write");
}

function toMutableBuffer(view: NodeJS.ArrayBufferView): Buffer {
	if (Buffer.isBuffer(view)) return view;
	return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function coercePosition(pos: number | null | undefined): number | null {
	if (pos === undefined || pos === null || pos === -1) return null;
	if (!Number.isInteger(pos) || pos < 0) {
		throw createFsError("EINVAL", -22, "invalid position", "read");
	}
	return pos;
}

function isArrayBufferView(value: unknown): value is NodeJS.ArrayBufferView {
	return (
		typeof value === "object" && value !== null && ArrayBuffer.isView(value)
	);
}

let nextFd = 10;

export class FileHandle {
	readonly #path: string;
	readonly #flags: OpenFlags;
	readonly #fd: number;

	#closed = false;
	#position = 0;
	#fragments: Fragment[] = [];
	#fullBuffer: Buffer | undefined;
	#fullBufferMtimeMs: number | undefined;
	#dirty = false;
	#queue: Promise<void> = Promise.resolve();

	private constructor(path: string, flags: OpenFlags) {
		this.#path = path;
		this.#flags = flags;
		this.#fd = nextFd++;
	}

	static async open(
		pathLike: string | Buffer | URL,
		flagsLike?: string | number
	): Promise<FileHandle> {
		const path = normalizePath(pathLike);
		const flags = parseOpenFlags(flagsLike);

		let existing: any | null = null;
		try {
			existing = await statRaw(path);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") throw error;
		}

		if (flags.exclusive && existing) {
			throw createFsError("EEXIST", -17, "file already exists", "open", path);
		}
		if (!existing && !flags.create) {
			throw createFsError(
				"ENOENT",
				-2,
				"no such file or directory",
				"open",
				path
			);
		}

		if (!existing && flags.create) {
			await writeWholeFile(path, Buffer.alloc(0));
			existing = await statRaw(path);
		} else if (existing && flags.truncateOnOpen) {
			await writeWholeFile(path, Buffer.alloc(0));
			existing = await statRaw(path);
		}

		const handle = new FileHandle(path, flags);
		if (flags.truncateOnOpen || (!existing && flags.create)) {
			handle.#fullBuffer = Buffer.alloc(0);
			handle.#fullBufferMtimeMs = existing ? statMtimeMs(existing) : undefined;
			handle.#fragments = [];
		}
		return handle;
	}

	get fd(): number {
		return this.#fd;
	}

	async #serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	#assertOpen() {
		if (this.#closed) {
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				"read",
				this.#path
			);
		}
	}

	#assertCanRead() {
		if (!this.#flags.read) {
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				"read",
				this.#path
			);
		}
	}

	#assertCanWrite() {
		if (!this.#flags.write) {
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				"write",
				this.#path
			);
		}
	}

	async #ensureWritableBuffer(): Promise<void> {
		if (!this.#fullBuffer) {
			this.#fullBuffer = await readWholeFile(this.#path);
			const stat = await statRaw(this.#path);
			this.#fullBufferMtimeMs = statMtimeMs(stat);
			this.#fragments = [];
			return;
		}

		if (this.#dirty) return;

		if (this.#fullBufferMtimeMs !== undefined) {
			const current = await statRaw(this.#path);
			const currentMtime = statMtimeMs(current);
			if (currentMtime !== this.#fullBufferMtimeMs) {
				this.#fullBuffer = await readWholeFile(this.#path);
				this.#fullBufferMtimeMs = currentMtime;
				this.#fragments = [];
			}
		}
	}

	#getMissingRanges(start: number, end: number): Array<[number, number]> {
		if (end <= start) return [];
		const ranges: Array<[number, number]> = [];
		let cursor = start;

		for (const fragment of this.#fragments) {
			if (fragment.end <= cursor) continue;
			if (fragment.start >= end) break;

			if (fragment.start > cursor) {
				ranges.push([cursor, Math.min(fragment.start, end)]);
			}

			cursor = Math.max(cursor, Math.min(fragment.end, end));
			if (cursor >= end) break;
		}

		if (cursor < end) ranges.push([cursor, end]);
		return ranges;
	}

	#mergeFragments(): void {
		if (this.#fragments.length < 2) return;
		this.#fragments.sort((a, b) => a.start - b.start);

		const merged: Fragment[] = [this.#fragments[0]];
		for (let i = 1; i < this.#fragments.length; i++) {
			const prev = merged[merged.length - 1];
			const curr = this.#fragments[i];

			if (curr.start > prev.end) {
				merged.push(curr);
				continue;
			}

			const start = prev.start;
			const end = Math.max(prev.end, curr.end);
			const data = Buffer.alloc(end - start);
			prev.data.copy(data, prev.start - start);
			curr.data.copy(data, curr.start - start);
			merged[merged.length - 1] = { start, end, data };
		}

		this.#fragments = merged;
	}

	#addFragment(start: number, data: Buffer): void {
		if (data.length === 0) return;
		this.#fragments.push({
			start,
			end: start + data.length,
			data: Buffer.from(data),
		});
		this.#mergeFragments();
	}

	async #ensureReadRanges(start: number, end: number): Promise<void> {
		const missing = this.#getMissingRanges(start, end);
		for (const [rangeStart, rangeEnd] of missing) {
			const size = rangeEnd - rangeStart;
			const data = await readRange(this.#path, rangeStart, size);
			if (data.length === 0) break;
			this.#addFragment(rangeStart, data);
			if (data.length < size) break;
		}
	}

	#readFromFragments(
		target: Buffer,
		targetOffset: number,
		start: number,
		end: number
	): number {
		let cursor = start;
		let written = 0;

		for (const fragment of this.#fragments) {
			if (fragment.end <= cursor) continue;
			if (fragment.start > cursor) break;
			if (fragment.start <= cursor && fragment.end > cursor) {
				const takeUntil = Math.min(fragment.end, end);
				const take = takeUntil - cursor;
				if (take <= 0) continue;
				fragment.data.copy(
					target,
					targetOffset + written,
					cursor - fragment.start,
					cursor - fragment.start + take
				);
				cursor += take;
				written += take;
				if (cursor >= end) break;
			}
		}

		return written;
	}

	#applyWrite(position: number, data: Buffer): void {
		if (!this.#fullBuffer) this.#fullBuffer = Buffer.alloc(0);

		const required = position + data.length;
		if (required > this.#fullBuffer.length) {
			const expanded = Buffer.alloc(required);
			this.#fullBuffer.copy(expanded, 0);
			this.#fullBuffer = expanded;
		}

		data.copy(this.#fullBuffer, position);
		this.#dirty = true;
	}

	async #syncUnlocked(): Promise<void> {
		if (!this.#dirty || !this.#fullBuffer) return;
		await writeWholeFile(this.#path, this.#fullBuffer);
		const updated = await statRaw(this.#path);
		this.#fullBufferMtimeMs = statMtimeMs(updated);
		this.#dirty = false;
		this.#fragments = [];
	}

	async close(): Promise<void> {
		return this.#serialize(async () => {
			if (this.#closed) return;
			if (this.#dirty) {
				await this.#syncUnlocked();
			}
			this.#closed = true;
		});
	}

	async sync(): Promise<void> {
		return this.#serialize(async () => {
			this.#assertOpen();
			await this.#syncUnlocked();
		});
	}

	async datasync(): Promise<void> {
		return this.sync();
	}

	async stat(options?: {
		bigint?: boolean;
	}): Promise<InstanceType<typeof Stats>> {
		return this.#serialize(async () => {
			this.#assertOpen();
			const raw = await statRaw(this.#path);
			return new Stats(raw, options?.bigint || false);
		});
	}

	async read(
		bufferOrOptions?:
			| NodeJS.ArrayBufferView
			| {
					buffer?: NodeJS.ArrayBufferView;
					offset?: number;
					length?: number;
					position?: number | null;
			  },
		offsetArg?: number,
		lengthArg?: number,
		positionArg?: number | null
	): Promise<{ bytesRead: number; buffer: NodeJS.ArrayBufferView }> {
		return this.#serialize(async () => {
			this.#assertOpen();
			this.#assertCanRead();

			let inputBuffer: NodeJS.ArrayBufferView;
			let offset = 0;
			let length: number;
			let position: number | null;

			if (isArrayBufferView(bufferOrOptions) || bufferOrOptions === undefined) {
				inputBuffer =
					bufferOrOptions ??
					(Buffer.alloc(16384) as unknown as NodeJS.ArrayBufferView);
				offset = offsetArg ?? 0;
				const mutable = toMutableBuffer(inputBuffer);
				length = lengthArg ?? mutable.byteLength - offset;
				position = coercePosition(positionArg);
			} else {
				const readOptions = bufferOrOptions;
				inputBuffer =
					readOptions.buffer ??
					(Buffer.alloc(16384) as unknown as NodeJS.ArrayBufferView);
				offset = readOptions.offset ?? 0;
				const mutable = toMutableBuffer(inputBuffer);
				length = readOptions.length ?? mutable.byteLength - offset;
				position = coercePosition(readOptions.position);
			}

			const target = toMutableBuffer(inputBuffer);

			if (!Number.isInteger(offset) || offset < 0) {
				throw createFsError(
					"EINVAL",
					-22,
					"invalid offset",
					"read",
					this.#path
				);
			}
			if (!Number.isInteger(length) || length < 0) {
				throw createFsError(
					"EINVAL",
					-22,
					"invalid length",
					"read",
					this.#path
				);
			}
			if (offset + length > target.length) {
				throw createFsError(
					"EINVAL",
					-22,
					"invalid length",
					"read",
					this.#path
				);
			}

			const fromCurrent = position === null;
			const readStart = fromCurrent ? this.#position : (position as number);
			const readEnd = readStart + length;

			let bytesRead = 0;
			if (length === 0) {
				bytesRead = 0;
			} else if (this.#fullBuffer) {
				if (readStart < this.#fullBuffer.length) {
					bytesRead = Math.min(length, this.#fullBuffer.length - readStart);
					this.#fullBuffer.copy(
						target,
						offset,
						readStart,
						readStart + bytesRead
					);
				}
			} else {
				await this.#ensureReadRanges(readStart, readEnd);
				bytesRead = this.#readFromFragments(target, offset, readStart, readEnd);
			}

			if (fromCurrent) {
				this.#position += bytesRead;
			}

			return { bytesRead, buffer: inputBuffer };
		});
	}

	async readFile(
		options?: BufferEncoding | { encoding?: BufferEncoding | null }
	): Promise<Buffer | string> {
		return this.#serialize(async () => {
			this.#assertOpen();
			this.#assertCanRead();

			let encoding: BufferEncoding | null | undefined;
			if (typeof options === "string") encoding = options;
			else encoding = options?.encoding;

			if (!this.#fullBuffer) {
				this.#fullBuffer = await readWholeFile(this.#path);
				const raw = await statRaw(this.#path);
				this.#fullBufferMtimeMs = statMtimeMs(raw);
				this.#fragments = [];
			}

			const slice = this.#fullBuffer.subarray(this.#position);
			this.#position = this.#fullBuffer.length;

			if (encoding) return slice.toString(encoding);
			return Buffer.from(slice);
		});
	}

	async write(
		bufferOrString: string | NodeJS.ArrayBufferView,
		offsetOrPosition?:
			| number
			| { offset?: number; length?: number; position?: number | null }
			| null,
		lengthOrEncoding?: number | BufferEncoding,
		positionArg?: number | null
	): Promise<{
		bytesWritten: number;
		buffer: string | NodeJS.ArrayBufferView;
	}> {
		return this.#serialize(async () => {
			this.#assertOpen();
			this.#assertCanWrite();
			await this.#ensureWritableBuffer();

			if (typeof bufferOrString === "string") {
				let position: number | null = null;
				let encoding: BufferEncoding | undefined = "utf8";

				if (typeof offsetOrPosition === "number" || offsetOrPosition === null) {
					position = coercePosition(offsetOrPosition);
				}
				if (typeof lengthOrEncoding === "string") {
					encoding = lengthOrEncoding;
				}

				const source = toBufferValue(bufferOrString, encoding);
				const fromCurrent = this.#flags.append || position === null;
				const writePosition = this.#flags.append
					? this.#fullBuffer!.length
					: fromCurrent
						? this.#position
						: (position as number);

				this.#applyWrite(writePosition, source);
				if (fromCurrent) this.#position = writePosition + source.length;

				return { bytesWritten: source.length, buffer: bufferOrString };
			}

			const sourceAll = toBufferValue(bufferOrString);
			let offset = 0;
			let length = sourceAll.byteLength;
			let position: number | null = null;

			if (typeof offsetOrPosition === "object" && offsetOrPosition !== null) {
				offset = offsetOrPosition.offset ?? 0;
				length = offsetOrPosition.length ?? sourceAll.byteLength - offset;
				position = coercePosition(offsetOrPosition.position);
			} else {
				offset = (offsetOrPosition as number | undefined) ?? 0;
				if (typeof lengthOrEncoding === "number") {
					length = lengthOrEncoding;
				}
				position = coercePosition(positionArg);
			}

			if (!Number.isInteger(offset) || offset < 0) {
				throw createFsError(
					"EINVAL",
					-22,
					"invalid offset",
					"write",
					this.#path
				);
			}
			if (!Number.isInteger(length) || length < 0) {
				throw createFsError(
					"EINVAL",
					-22,
					"invalid length",
					"write",
					this.#path
				);
			}
			if (offset + length > sourceAll.length) {
				throw createFsError(
					"EINVAL",
					-22,
					"invalid length",
					"write",
					this.#path
				);
			}

			const source = sourceAll.subarray(offset, offset + length);
			const fromCurrent = this.#flags.append || position === null;
			const writePosition = this.#flags.append
				? this.#fullBuffer!.length
				: fromCurrent
					? this.#position
					: (position as number);

			this.#applyWrite(writePosition, source);
			if (fromCurrent) this.#position = writePosition + source.length;

			return { bytesWritten: source.length, buffer: bufferOrString };
		});
	}

	async writeFile(
		data: string | NodeJS.ArrayBufferView | ArrayBuffer,
		options?: BufferEncoding | { encoding?: BufferEncoding | null }
	): Promise<void> {
		return this.#serialize(async () => {
			this.#assertOpen();
			this.#assertCanWrite();
			await this.#ensureWritableBuffer();

			let encoding: BufferEncoding | undefined;
			if (typeof options === "string") encoding = options;
			else encoding = options?.encoding ?? undefined;

			this.#fullBuffer = Buffer.from(toBufferValue(data, encoding));
			this.#dirty = true;
			this.#position = this.#fullBuffer.length;
			this.#fragments = [];
		});
	}

	async appendFile(
		data: string | NodeJS.ArrayBufferView | ArrayBuffer,
		options?: BufferEncoding | { encoding?: BufferEncoding | null }
	): Promise<void> {
		return this.#serialize(async () => {
			this.#assertOpen();
			this.#assertCanWrite();
			await this.#ensureWritableBuffer();

			let encoding: BufferEncoding | undefined;
			if (typeof options === "string") encoding = options;
			else encoding = options?.encoding ?? undefined;

			const source = toBufferValue(data, encoding);
			const pos = this.#fullBuffer!.length;
			this.#applyWrite(pos, source);
			this.#position = pos + source.length;
		});
	}

	async truncate(len = 0): Promise<void> {
		return this.#serialize(async () => {
			this.#assertOpen();
			this.#assertCanWrite();
			await this.#ensureWritableBuffer();

			if (!Number.isInteger(len)) len = Math.trunc(len);
			if (len < 0) len = 0;

			if (len <= this.#fullBuffer!.length) {
				this.#fullBuffer = Buffer.from(this.#fullBuffer!.subarray(0, len));
			} else {
				const expanded = Buffer.alloc(len);
				this.#fullBuffer!.copy(expanded, 0);
				this.#fullBuffer = expanded;
			}

			this.#dirty = true;
			this.#fragments = [];
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
