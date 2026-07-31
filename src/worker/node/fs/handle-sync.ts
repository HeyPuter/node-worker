import { decode, fetchPuterSync, getRandomId } from "../../puter";
import nodeBuffer from "../buffer";
import nodePath from "../path";
import { Stats } from "./classes";
import {
	createFsError,
	normalizePath,
	normalizeFsEntry,
	parseOpenFlags,
	readUrl,
	statRequest,
	translatePuterError,
	type OpenFlags,
} from "./util";
import { allocFd, fdTable } from "./fd-table";

let Buffer = nodeBuffer.Buffer;

// Synchronous counterpart to FileHandle. puterfs exposes no partial-write
// primitive, so writes accumulate into a whole-file buffer and flush on
// sync()/close(); reads pull the whole file in lazily. This is the simpler
// (no fragment cache) sibling of the async handle — sync callers tend to be
// openSync→read/write→closeSync, which this serves directly.
function statRawSync(path: string): any {
	const [ok, u8array] = fetchPuterSync("stat", statRequest(path));
	const res = decode(u8array);
	if (!ok)
		throw translatePuterError(res.code, "stat", path) ?? new Error(res.message);
	return res;
}

function readWholeFileSync(path: string): Buffer {
	const [ok, u8array] = fetchPuterSync(readUrl(path));
	if (!ok) {
		const res = decode(u8array);
		throw translatePuterError(res.code, "open", path) ?? new Error(res.message);
	}
	return Buffer.from(u8array);
}

function writeWholeFileSync(path: string, buf: Buffer): void {
	const name = nodePath.basename(path);
	const parent = nodePath.dirname(path);
	const [_ok, u8array] = fetchPuterSync("batch", (form) => {
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
	if (result.success === false)
		throw (
			translatePuterError(result.code, "write", path) ??
			new Error(result.message)
		);
}

function toMutableBuffer(view: NodeJS.ArrayBufferView): Buffer {
	if (Buffer.isBuffer(view)) return view;
	return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

export class SyncFileHandle {
	readonly path: string;
	readonly flags: OpenFlags;
	readonly fd: number;

	#closed = false;
	#position = 0;
	#buffer: Buffer | undefined;
	#dirty = false;

	private constructor(
		path: string,
		flags: OpenFlags,
		buffer: Buffer | undefined
	) {
		this.path = path;
		this.flags = flags;
		this.#buffer = buffer;
		this.fd = allocFd();
		fdTable.set(this.fd, this);
	}

	static open(
		pathLike: string | Buffer | URL,
		flagsLike?: string | number
	): SyncFileHandle {
		const path = normalizePath(pathLike);
		const flags = parseOpenFlags(flagsLike);

		let existing: any | null = null;
		try {
			existing = statRawSync(path);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") throw error;
		}

		if (flags.exclusive && existing)
			throw createFsError("EEXIST", -17, "file already exists", "open", path);
		if (!existing && !flags.create)
			throw createFsError(
				"ENOENT",
				-2,
				"no such file or directory",
				"open",
				path
			);

		if (!existing && flags.create) {
			writeWholeFileSync(path, Buffer.alloc(0));
		} else if (existing && flags.truncateOnOpen) {
			writeWholeFileSync(path, Buffer.alloc(0));
		}

		// Files we just created/truncated start empty; otherwise read lazily.
		const buffer =
			flags.truncateOnOpen || (!existing && flags.create)
				? Buffer.alloc(0)
				: undefined;
		return new SyncFileHandle(path, flags, buffer);
	}

	#assertOpen(syscall: string) {
		if (this.#closed)
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				syscall,
				this.path
			);
	}

	#ensureBuffer(): Buffer {
		if (this.#buffer === undefined) this.#buffer = readWholeFileSync(this.path);
		return this.#buffer;
	}

	#applyWrite(position: number, data: Buffer): void {
		let buf = this.#ensureBuffer();
		const required = position + data.length;
		if (required > buf.length) {
			const expanded = Buffer.alloc(required);
			buf.copy(expanded, 0);
			buf = expanded;
			this.#buffer = expanded;
		}
		data.copy(buf, position);
		this.#dirty = true;
	}

	read(
		target: NodeJS.ArrayBufferView,
		offset: number,
		length: number,
		position: number | null
	): number {
		this.#assertOpen("read");
		if (!this.flags.read)
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				"read",
				this.path
			);

		const dest = toMutableBuffer(target);
		const buf = this.#ensureBuffer();
		const start =
			position === null || position === undefined ? this.#position : position;

		let bytesRead = 0;
		if (length > 0 && start < buf.length) {
			bytesRead = Math.min(length, buf.length - start);
			buf.copy(dest, offset, start, start + bytesRead);
		}
		if (position === null || position === undefined)
			this.#position += bytesRead;
		return bytesRead;
	}

	write(data: Buffer, position: number | null): number {
		this.#assertOpen("write");
		if (!this.flags.write)
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				"write",
				this.path
			);

		const buf = this.#ensureBuffer();
		const fromCurrent =
			this.flags.append || position === null || position === undefined;
		const writePosition = this.flags.append
			? buf.length
			: fromCurrent
				? this.#position
				: position;

		this.#applyWrite(writePosition, data);
		if (fromCurrent) this.#position = writePosition + data.length;
		return data.length;
	}

	truncate(len: number): void {
		this.#assertOpen("ftruncate");
		if (!this.flags.write)
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				"ftruncate",
				this.path
			);

		const buf = this.#ensureBuffer();
		if (!Number.isInteger(len)) len = Math.trunc(len);
		if (len < 0) len = 0;

		if (len <= buf.length) {
			this.#buffer = Buffer.from(buf.subarray(0, len));
		} else {
			const expanded = Buffer.alloc(len);
			buf.copy(expanded, 0);
			this.#buffer = expanded;
		}
		this.#dirty = true;
	}

	stat(bigint: boolean): InstanceType<typeof Stats> {
		this.#assertOpen("fstat");
		return new Stats(normalizeFsEntry(statRawSync(this.path)), bigint);
	}

	sync(): void {
		this.#assertOpen("fsync");
		if (this.#dirty && this.#buffer) {
			writeWholeFileSync(this.path, this.#buffer);
			this.#dirty = false;
		}
	}

	close(): void {
		if (this.#closed) return;
		if (this.#dirty && this.#buffer)
			writeWholeFileSync(this.path, this.#buffer);
		this.#dirty = false;
		this.#closed = true;
		fdTable.delete(this.fd);
	}
}
