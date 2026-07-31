// The one open-file handle, serving both fd families.
//
// There used to be two of these — an async `FileHandle` and a `SyncFileHandle` —
// with the same state machine written twice and an `instanceof` check in the fd
// table keeping them apart, which meant an fd from `openSync` was rejected with
// EBADF by `fs.read`. Node has one process-wide fd space and no such split; now so
// do we. The operations are plans, so the async surface runs them with `runAsync`
// and the sync surface with `runSync`, and an fd works with either family.
//
// ## No lock
//
// The old async handle serialized every operation through a promise queue, because
// a "write" here is a multi-round-trip read-modify-write over mutable handle state
// (puterfs has no partial-write primitive — see ./vfs/puter.ts) and two overlapping
// `await handle.write()` calls would interleave at every await and lose data. A
// *sync* operation cannot await that queue, and it can genuinely arrive while the
// queue is held (`let p = handle.readFile(); fs.readSync(fd, …)`). Rejecting that
// with EBUSY would invent a failure mode node doesn't have.
//
// So the invariant moved instead of the lock, via two mechanisms that hold under
// either driver:
//
//   1. **Offsets are reserved synchronously.** `#position` and `#appendCursor` are
//      advanced in straight-line code *before* the first yield, so two concurrent
//      operations can never target the same offset. A read that comes back short
//      rolls its unused tail back only if nothing else reserved in the meantime.
//   2. **Buffer fills are double-checked.** `#fill` returns early when the handle is
//      dirty, and re-checks `#dirty` *after* the yield before assigning what it
//      fetched. Two concurrent fills both fetch and both assign identical bytes, so
//      last-writer-wins is correct; the only ordering that matters is that a fill
//      must never overwrite unflushed writes.
//
// `close()` bumps `#generation`, and any operation resuming after a yield into a
// changed generation throws EBADF — which is what node does to in-flight I/O on a
// closed fd, so it is a convergence rather than a divergence.

import nodeBuffer from "../buffer";
import { Stats } from "./classes";
import {
	createFsError,
	normalizePath,
	parseOpenFlags,
	toWriteBuffer,
	type FsEntry,
	type OpenFlags,
} from "./util";
import { allocFd, fdTable } from "./fd-table";
import { runAsync, runSync } from "./driver";
import { ctx, vfs } from "./vfs";
import { utimesPlan } from "./times";
import type { Plan } from "./plan";
// NOT a direct import of ./streams: that edge would pull the stream classes into
// the fs module-init cycle, where `class ReadStream extends Readable` runs before
// ../stream.ts exists. ./stream-registry.ts explains the arrangement.
import { streamCtors } from "./stream-registry";
import nodeStream from "../stream";

let Buffer = nodeBuffer.Buffer;

type Fragment = {
	start: number;
	end: number;
	data: Buffer;
};

function toMutableBuffer(view: NodeJS.ArrayBufferView): Buffer {
	if (Buffer.isBuffer(view)) return view;
	return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function coercePosition(pos: number | bigint | null | undefined): number | null {
	if (typeof pos === "bigint") pos = Number(pos);
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

// Splits a text stream into lines. Deliberately hand-rolled rather than
// delegating to node:readline — see FileHandle#readLines.
function makeLineReader(stream: any) {
	let lines: string[] = [];
	let pending = "";
	let waiters: Array<() => void> = [];
	let ended = false;
	let error: Error | undefined;
	let listeners: Array<(line: string) => void> = [];
	let closeListeners: Array<() => void> = [];

	let wake = () => {
		for (let w of waiters.splice(0)) w();
	};
	let push = (line: string) => {
		for (let fn of listeners) fn(line);
		lines.push(line);
	};

	stream.on("data", (chunk: any) => {
		pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let parts = pending.split("\n");
		pending = parts.pop() ?? "";
		for (let part of parts) {
			// Tolerate CRLF the way readline's crlfDelay:Infinity does.
			push(part.endsWith("\r") ? part.slice(0, -1) : part);
		}
		wake();
	});
	stream.on("error", (err: Error) => {
		error = err;
		ended = true;
		wake();
	});
	stream.on("end", () => {
		// A trailing fragment with no newline is still a line.
		if (pending.length > 0) {
			push(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
			pending = "";
		}
		ended = true;
		for (let fn of closeListeners) fn();
		wake();
	});

	return {
		on(event: string, fn: any) {
			if (event === "line") listeners.push(fn);
			else if (event === "close") closeListeners.push(fn);
			return this;
		},
		close() {
			stream.destroy();
			ended = true;
			wake();
		},
		async *[Symbol.asyncIterator]() {
			while (true) {
				while (lines.length > 0) yield lines.shift()!;
				if (error) throw error;
				if (ended) return;
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
	};
}

export class FileHandle {
	readonly #path: string;
	readonly #flags: OpenFlags;
	readonly #fd: number;

	#closing = false;
	#closed = false;
	/** Bumped by close(); an operation resuming into a new generation is stale. */
	#generation = 0;

	#position = 0;
	/** Where the next append lands. Reserved synchronously, like #position. */
	#appendCursor = 0;
	/** Sequence number for offset reservations; see #reserve / #settle. */
	#reserveSeq = 0;

	/** Byte-range cache, used only when the backend has a real ranged read. */
	#fragments: Fragment[] = [];
	/** Whole-file buffer: the truth once anything has been written. */
	#buffer: Buffer | undefined;
	#bufferMtimeMs: number | undefined;
	/** Whether #buffer is ours to mutate, or still aliases what a provider handed us. */
	#owned = false;
	/** Last known size on the backend, used to keep ranged reads inside the file. */
	#serverSize: number | undefined;
	#dirty = false;
	// No `#pin` yet. `FsProvider#pin` exists so a handle can keep referring to the
	// same *file* after its path is rewritten or unlinked, but puterfs exposes no
	// inode and returns undefined, so there is nothing to hold onto and nothing that
	// would behave differently. It gets captured here when the in-memory provider
	// lands and the distinction starts to mean something.

	private constructor(path: string, flags: OpenFlags) {
		this.#path = path;
		this.#flags = flags;
		this.#fd = allocFd();
		fdTable.set(this.#fd, this);
	}

	// ---------------------------------------------------------------- open

	static *openPlan(
		pathLike: string | Buffer | URL,
		flagsLike?: string | number
	): Plan<FileHandle> {
		const path = normalizePath(pathLike);
		const flags = parseOpenFlags(flagsLike);
		const c = ctx("open", path);

		let existing: FsEntry | undefined;
		try {
			existing = yield* vfs.stat(c, path);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
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

		let emptied = false;
		if ((!existing && flags.create) || (existing && flags.truncateOnOpen)) {
			yield* vfs.writeFile(c, path, Buffer.alloc(0));
			emptied = true;
		}

		const handle = new FileHandle(path, flags);

		if (emptied) {
			// No re-stat here. The old code issued one purely to learn the size and
			// mtime of a file it had just emptied — the size is zero by construction,
			// and the mtime was only used to decide whether to re-read before a write,
			// which is pointless for a handle about to replace the whole file anyway
			// (every write is a whole-file upload). Leaving the mtime undefined
			// disables that revalidation, which is what makes skipping the round trip
			// safe. One request saved on every `open(path, "w")`.
			handle.#serverSize = 0;
			handle.#appendCursor = 0;
			handle.#buffer = Buffer.alloc(0);
			handle.#owned = true;
			handle.#bufferMtimeMs = undefined;
		} else {
			handle.#serverSize = existing?.size ?? 0;
			handle.#appendCursor = handle.#serverSize;
		}
		return handle;
	}

	static async open(
		pathLike: string | Buffer | URL,
		flagsLike?: string | number
	): Promise<FileHandle> {
		return runAsync(FileHandle.openPlan(pathLike, flagsLike));
	}

	/** @internal — the `openSync` family. */
	static openSync(
		pathLike: string | Buffer | URL,
		flagsLike?: string | number
	): FileHandle {
		return runSync(FileHandle.openPlan(pathLike, flagsLike));
	}

	get fd(): number {
		return this.#fd;
	}

	/** @internal — `futimes` and the stream constructors need the opened path. */
	get filePath(): string {
		return this.#path;
	}

	/** @internal */
	get flags(): OpenFlags {
		return this.#flags;
	}

	// ------------------------------------------------------- state guards

	#assertOpen(syscall: string) {
		if (this.#closed || this.#closing) {
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				syscall,
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

	/**
	 * Called after every yield: an operation that resumes into a closed handle, or
	 * one whose generation moved, has had the fd pulled out from under it.
	 */
	#assertStillValid(gen: number, syscall: string) {
		if (this.#closed || gen !== this.#generation) {
			throw createFsError(
				"EBADF",
				-9,
				"bad file descriptor",
				syscall,
				this.#path
			);
		}
	}

	// -------------------------------------------------- offset reservation

	#reserve(n: number): { at: number; token: number } {
		const at = this.#position;
		this.#position += n;
		return { at, token: ++this.#reserveSeq };
	}

	/**
	 * Give back the tail of a reservation that went unused (a short read). Only safe
	 * while we are still the most recent reservation — if another operation reserved
	 * since, rewinding would hand it overlapping bytes.
	 */
	#settle(r: { at: number; token: number }, actual: number) {
		if (r.token === this.#reserveSeq) this.#position = r.at + actual;
	}

	#reserveAppend(n: number): number {
		const at = this.#appendCursor;
		this.#appendCursor += n;
		return at;
	}

	// ------------------------------------------------------ buffer filling

	/** Make #buffer safe to mutate in place. */
	#takeOwnership() {
		if (!this.#owned) {
			this.#buffer = Buffer.from(this.#buffer ?? Buffer.alloc(0));
			this.#owned = true;
		}
	}

	/**
	 * Ensure #buffer holds the file's current contents. Never overwrites unflushed
	 * writes — see the note on double-checked fills at the top of this file.
	 */
	*#fill(syscall: string): Plan<Buffer> {
		if (this.#dirty) return this.#buffer!;

		const c = ctx(syscall, this.#path);
		const gen = this.#generation;

		if (this.#buffer !== undefined) {
			if (this.#bufferMtimeMs === undefined) return this.#buffer;
			// Revalidate against the backend's mtime. Superseded by the cache's
			// content epoch in a later step: puterfs mtime has one-second resolution,
			// so a read-modify-write inside one second cannot be detected this way.
			const current = yield* vfs.stat(c, this.#path);
			this.#assertStillValid(gen, syscall);
			if (this.#dirty) return this.#buffer!;
			if (current.modifiedMs === this.#bufferMtimeMs) return this.#buffer;
			this.#bufferMtimeMs = current.modifiedMs;
			this.#serverSize = current.size;
		}

		const fetched = yield* vfs.readFile(c, this.#path);
		this.#assertStillValid(gen, syscall);
		// A write landed while the read was in flight; its bytes win.
		if (this.#dirty) return this.#buffer!;

		this.#buffer = fetched;
		this.#owned = false;
		this.#fragments = [];
		this.#serverSize = fetched.length;
		this.#appendCursor = Math.max(this.#appendCursor, fetched.length);
		return fetched;
	}

	/**
	 * Fill #buffer and make sure its mtime is recorded, so a later clean fill can
	 * tell whether someone else has since changed the file.
	 */
	*#fillForWrite(syscall: string): Plan<Buffer> {
		const first = this.#buffer === undefined;
		const buf = yield* this.#fill(syscall);
		if (first && !this.#dirty && this.#bufferMtimeMs === undefined) {
			const stat = yield* vfs.stat(ctx(syscall, this.#path), this.#path);
			this.#bufferMtimeMs = stat.modifiedMs;
		}
		return buf;
	}

	// ------------------------------------------------------ fragment cache

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

	*#ensureRanges(start: number, end: number): Plan<void> {
		const c = ctx("read", this.#path);
		const gen = this.#generation;

		// Never request a range starting at or past EOF: the api answers those with a
		// 500, not a 416. Re-stat before concluding EOF, so a file another client has
		// grown since we opened it is still readable.
		if (this.#serverSize === undefined || start >= this.#serverSize) {
			const stat = yield* vfs.stat(c, this.#path);
			this.#assertStillValid(gen, "read");
			this.#serverSize = stat.size;
		}
		if (start >= this.#serverSize) return;

		const limit = Math.min(end, this.#serverSize);
		for (const [rangeStart, rangeEnd] of this.#getMissingRanges(start, limit)) {
			const size = rangeEnd - rangeStart;
			const data = yield* vfs.readRange(c, this.#path, rangeStart, size);
			this.#assertStillValid(gen, "read");
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

	// -------------------------------------------------------------- read

	/** @internal The normalized read both surfaces drive. Returns bytes read. */
	*readPlan(
		target: NodeJS.ArrayBufferView,
		offset: number,
		length: number,
		position: number | null
	): Plan<number> {
		this.#assertOpen("read");
		this.#assertCanRead();

		const dest = toMutableBuffer(target);

		if (!Number.isInteger(offset) || offset < 0) {
			throw createFsError("EINVAL", -22, "invalid offset", "read", this.#path);
		}
		if (!Number.isInteger(length) || length < 0) {
			throw createFsError("EINVAL", -22, "invalid length", "read", this.#path);
		}
		if (offset + length > dest.length) {
			throw createFsError("EINVAL", -22, "invalid length", "read", this.#path);
		}
		if (length === 0) return 0;

		const fromCurrent = position === null;
		// Reserved before any yield, so two concurrent positionless reads can't be
		// handed the same bytes.
		const res = fromCurrent ? this.#reserve(length) : null;
		const readStart = res ? res.at : (position as number);
		const readEnd = readStart + length;

		let bytesRead = 0;
		if (this.#buffer !== undefined) {
			if (readStart < this.#buffer.length) {
				bytesRead = Math.min(length, this.#buffer.length - readStart);
				this.#buffer.copy(dest, offset, readStart, readStart + bytesRead);
			}
		} else if (vfs.hasNativeRange(this.#path)) {
			yield* this.#ensureRanges(readStart, readEnd);
			bytesRead = this.#readFromFragments(dest, offset, readStart, readEnd);
		} else {
			// No real ranged read on this backend, so holding the whole file once
			// beats slicing it out of a fresh full download per positioned read.
			const buf = yield* this.#fill("read");
			if (readStart < buf.length) {
				bytesRead = Math.min(length, buf.length - readStart);
				buf.copy(dest, offset, readStart, readStart + bytesRead);
			}
		}

		if (res) this.#settle(res, bytesRead);
		return bytesRead;
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
		let inputBuffer: NodeJS.ArrayBufferView;
		let offset: number;
		let length: number;
		let position: number | null;

		if (isArrayBufferView(bufferOrOptions) || bufferOrOptions === undefined) {
			inputBuffer =
				bufferOrOptions ??
				(Buffer.alloc(16384) as unknown as NodeJS.ArrayBufferView);
			offset = offsetArg ?? 0;
			length = lengthArg ?? toMutableBuffer(inputBuffer).byteLength - offset;
			position = coercePosition(positionArg);
		} else {
			const o = bufferOrOptions;
			inputBuffer =
				o.buffer ?? (Buffer.alloc(16384) as unknown as NodeJS.ArrayBufferView);
			offset = o.offset ?? 0;
			length = o.length ?? toMutableBuffer(inputBuffer).byteLength - offset;
			position = coercePosition(o.position);
		}

		const bytesRead = await runAsync(
			this.readPlan(inputBuffer, offset, length, position)
		);
		return { bytesRead, buffer: inputBuffer };
	}

	/** @internal */
	*readFilePlan(): Plan<Buffer> {
		this.#assertOpen("read");
		this.#assertCanRead();
		const buf = yield* this.#fill("read");
		// Reads from the handle's offset to EOF, as node's does.
		const from = this.#position;
		this.#position = buf.length;
		return Buffer.from(buf.subarray(from));
	}

	async readFile(
		options?: BufferEncoding | { encoding?: BufferEncoding | null }
	): Promise<Buffer | string> {
		const encoding = typeof options === "string" ? options : options?.encoding;
		const buf = await runAsync(this.readFilePlan());
		return encoding ? buf.toString(encoding) : buf;
	}

	// ------------------------------------------------------------- write

	#splice(position: number, data: Buffer): void {
		this.#takeOwnership();
		let buf = this.#buffer ?? Buffer.alloc(0);
		const required = position + data.length;
		if (required > buf.length) {
			const expanded = Buffer.alloc(required);
			buf.copy(expanded, 0);
			buf = expanded;
		}
		data.copy(buf, position);
		this.#buffer = buf;
		this.#owned = true;
		this.#dirty = true;
	}

	/** @internal The normalized write both surfaces drive. Returns bytes written. */
	*writePlan(src: Buffer, position: number | null): Plan<number> {
		this.#assertOpen("write");
		this.#assertCanWrite();

		// Reserved before any yield: an append must land at a distinct offset even if
		// two writes are in flight, which is what O_APPEND guarantees and what the old
		// serialization queue was providing by accident.
		const fromCurrent = this.#flags.append || position === null;
		const at = this.#flags.append
			? this.#reserveAppend(src.length)
			: fromCurrent
				? this.#reserve(src.length).at
				: (position as number);

		const gen = this.#generation;
		yield* this.#fillForWrite("write");
		this.#assertStillValid(gen, "write");

		this.#splice(at, src);
		return src.length;
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
		let src: Buffer;
		let position: number | null;

		if (typeof bufferOrString === "string") {
			// write(string, position?, encoding?)
			position =
				typeof offsetOrPosition === "number" || offsetOrPosition === null
					? coercePosition(offsetOrPosition)
					: null;
			const encoding =
				typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8";
			src = toWriteBuffer(bufferOrString, encoding);
		} else {
			const all = toWriteBuffer(bufferOrString);
			let offset: number;
			let length: number;
			if (typeof offsetOrPosition === "object" && offsetOrPosition !== null) {
				offset = offsetOrPosition.offset ?? 0;
				length = offsetOrPosition.length ?? all.byteLength - offset;
				position = coercePosition(offsetOrPosition.position);
			} else {
				offset = (offsetOrPosition as number | undefined) ?? 0;
				length =
					typeof lengthOrEncoding === "number"
						? lengthOrEncoding
						: all.byteLength - offset;
				position = coercePosition(positionArg);
			}
			if (!Number.isInteger(offset) || offset < 0) {
				throw createFsError("EINVAL", -22, "invalid offset", "write", this.#path);
			}
			if (!Number.isInteger(length) || length < 0) {
				throw createFsError("EINVAL", -22, "invalid length", "write", this.#path);
			}
			if (offset + length > all.length) {
				throw createFsError("EINVAL", -22, "invalid length", "write", this.#path);
			}
			src = all.subarray(offset, offset + length);
		}

		const bytesWritten = await runAsync(this.writePlan(src, position));
		return { bytesWritten, buffer: bufferOrString };
	}

	/** @internal */
	*writeFilePlan(data: Buffer): Plan<void> {
		this.#assertOpen("write");
		this.#assertCanWrite();
		// The whole file is being replaced, so there is nothing to read first — but
		// the fill still runs so mtime bookkeeping is settled for a later clean read.
		const gen = this.#generation;
		yield* this.#fillForWrite("write");
		this.#assertStillValid(gen, "write");

		this.#buffer = Buffer.from(data);
		this.#owned = true;
		this.#dirty = true;
		this.#position = this.#buffer.length;
		this.#appendCursor = this.#buffer.length;
		this.#fragments = [];
	}

	async writeFile(
		data: string | NodeJS.ArrayBufferView | ArrayBuffer,
		options?: BufferEncoding | { encoding?: BufferEncoding | null }
	): Promise<void> {
		const encoding =
			typeof options === "string" ? options : (options?.encoding ?? undefined);
		await runAsync(this.writeFilePlan(toWriteBuffer(data, encoding)));
	}

	*#appendPlan(src: Buffer): Plan<void> {
		this.#assertOpen("write");
		this.#assertCanWrite();
		const gen = this.#generation;
		const buf = yield* this.#fillForWrite("write");
		this.#assertStillValid(gen, "write");
		// Appending through a handle means "after everything this handle knows about",
		// which is the later of the file's length and any append already reserved.
		const at = Math.max(buf.length, this.#appendCursor);
		this.#appendCursor = at + src.length;
		this.#splice(at, src);
		this.#position = at + src.length;
	}

	async appendFile(
		data: string | NodeJS.ArrayBufferView | ArrayBuffer,
		options?: BufferEncoding | { encoding?: BufferEncoding | null }
	): Promise<void> {
		const encoding =
			typeof options === "string" ? options : (options?.encoding ?? undefined);
		await runAsync(this.#appendPlan(toWriteBuffer(data, encoding)));
	}

	/** @internal */
	*truncatePlan(len = 0): Plan<void> {
		this.#assertOpen("ftruncate");
		this.#assertCanWrite();

		if (!Number.isInteger(len)) len = Math.trunc(len);
		if (len < 0) len = 0;

		const gen = this.#generation;
		const buf = yield* this.#fillForWrite("ftruncate");
		this.#assertStillValid(gen, "ftruncate");

		let out: Buffer;
		if (len <= buf.length) out = Buffer.from(buf.subarray(0, len));
		else {
			// Growing a file zero-fills, as ftruncate(2) does.
			out = Buffer.alloc(len);
			buf.copy(out, 0);
		}
		this.#buffer = out;
		this.#owned = true;
		this.#dirty = true;
		this.#appendCursor = len;
		this.#fragments = [];
	}

	async truncate(len = 0): Promise<void> {
		await runAsync(this.truncatePlan(len));
	}

	// ------------------------------------------------------- flush / close

	/** @internal */
	*syncPlan(): Plan<void> {
		if (!this.#dirty || !this.#buffer) return;
		const buf = this.#buffer;
		// Cleared before the upload so a write that lands during it marks the handle
		// dirty again, rather than having its flag wiped when this completes.
		this.#dirty = false;
		try {
			yield* vfs.writeFile(ctx("write", this.#path), this.#path, buf);
		} catch (err) {
			this.#dirty = true;
			throw err;
		}
		this.#serverSize = buf.length;
		this.#fragments = [];
		// The file has changed as far as the backend is concerned, and the provider
		// has already announced it. Drop the recorded mtime rather than spend a stat
		// learning the new one; a later read serves this buffer anyway.
		this.#bufferMtimeMs = undefined;
	}

	async sync(): Promise<void> {
		this.#assertOpen("fsync");
		await runAsync(this.syncPlan());
	}

	async datasync(): Promise<void> {
		return this.sync();
	}

	/** @internal */
	*closePlan(): Plan<void> {
		if (this.#closed) return;
		// #closing blocks new operations immediately; the generation bump makes any
		// already-suspended operation fail EBADF when it resumes.
		this.#closing = true;
		this.#generation++;
		try {
			yield* this.syncPlan();
		} finally {
			this.#closed = true;
			this.#closing = false;
			fdTable.delete(this.#fd);
		}
	}

	async close(): Promise<void> {
		await runAsync(this.closePlan());
	}

	// -------------------------------------------------------------- stat

	/** @internal */
	*statPlan(bigint: boolean): Plan<InstanceType<typeof Stats>> {
		this.#assertOpen("fstat");
		// A dirty handle's buffer IS the file as far as this fd is concerned, and
		// node's fstat on a dirty fd reports the real size. Synthesizing it is both
		// more correct than reporting the stale server size and one round trip
		// cheaper.
		if (this.#dirty && this.#buffer) {
			const now = Date.now();
			return new Stats(
				{
					path: this.#path,
					name: this.#path.slice(this.#path.lastIndexOf("/") + 1),
					uid: "",
					isDir: false,
					isSymlink: false,
					size: this.#buffer.length,
					modifiedMs: now,
					createdMs: now,
					accessedMs: now,
				},
				bigint
			);
		}
		const entry = yield* vfs.stat(ctx("fstat", this.#path), this.#path);
		return new Stats(entry, bigint);
	}

	async stat(options?: {
		bigint?: boolean;
	}): Promise<InstanceType<typeof Stats>> {
		return runAsync(this.statPlan(options?.bigint || false));
	}

	// -------------------------------------------------- no-op POSIX bits

	// puterfs has no mode/owner bits (Stats reports a constant 0o777), so these
	// validate the handle is open and otherwise no-op — matching how a lot of
	// tooling expects chmod/chown to "succeed".
	async chmod(_mode: number): Promise<void> {
		this.#assertOpen("fchmod");
	}

	async chown(_uid: number, _gid: number): Promise<void> {
		this.#assertOpen("fchown");
	}

	// The handle is already open, so a `false` from utimesPlan only means the
	// requested times weren't representable — there is no missing path to report.
	async utimes(
		atime: number | string | Date,
		mtime: number | string | Date
	): Promise<void> {
		this.#assertOpen("futime");
		await runAsync(utimesPlan(this.#path, atime, mtime));
	}

	// ----------------------------------------------------- scatter/gather

	// Each element is served sequentially; when `position` is given it advances by
	// the bytes transferred, otherwise the handle's own offset is used.
	async readv(
		buffers: readonly NodeJS.ArrayBufferView[],
		position?: number | null
	): Promise<{ bytesRead: number; buffers: NodeJS.ArrayBufferView[] }> {
		let total = 0;
		let pos = position ?? null;
		for (const buffer of buffers) {
			const bytesRead = await runAsync(
				this.readPlan(buffer, 0, buffer.byteLength, pos)
			);
			total += bytesRead;
			if (pos !== null) pos += bytesRead;
			if (bytesRead < buffer.byteLength) break;
		}
		return { bytesRead: total, buffers: buffers as NodeJS.ArrayBufferView[] };
	}

	async writev(
		buffers: readonly NodeJS.ArrayBufferView[],
		position?: number | null
	): Promise<{ bytesWritten: number; buffers: NodeJS.ArrayBufferView[] }> {
		let total = 0;
		let pos = position ?? null;
		for (const buffer of buffers) {
			const bytesWritten = await runAsync(
				this.writePlan(toWriteBuffer(buffer), pos)
			);
			total += bytesWritten;
			if (pos !== null) pos += bytesWritten;
		}
		return {
			bytesWritten: total,
			buffers: buffers as NodeJS.ArrayBufferView[],
		};
	}

	// ----------------------------------------------------------- streams

	createReadStream(options?: any): any {
		return new streamCtors.ReadStream!(this.#path, {
			...(options ?? {}),
			fd: this,
		});
	}

	createWriteStream(options?: any): any {
		return new streamCtors.WriteStream!(this.#path, {
			...(options ?? {}),
			fd: this,
		});
	}

	readableWebStream(options?: { type?: "bytes" | "default" }): ReadableStream {
		void options;
		// autoClose:false because the caller still owns this handle — node's
		// readableWebStream doesn't close it either.
		return (nodeStream.Readable as any).toWeb(
			this.createReadStream({ autoClose: false })
		) as unknown as ReadableStream;
	}

	// node returns a `readline.Interface` here. Importing node:readline would put
	// its subgraph — which reaches `internal/util/inspect`, whose top level calls
	// `internalBinding('util')` — into the fs bootstrap path, ahead of the binding
	// table. So this is a minimal stand-in: async-iterable, emits 'line'/'close',
	// and closeable, which covers what `readLines` is used for.
	readLines(options?: any): any {
		let stream = this.createReadStream({
			encoding: "utf8",
			...(options ?? {}),
		});
		return makeLineReader(stream);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
