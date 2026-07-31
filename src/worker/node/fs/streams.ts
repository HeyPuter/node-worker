// fs.createReadStream / fs.createWriteStream.
//
// Read side: a whole-file read is served by ONE streamed `read?file=` GET rather
// than a ranged request per chunk, which is the difference between 1 and
// ceil(size / highWaterMark) api calls for a large file. A `start`/`end` range
// or a caller-supplied fd falls back to reading through the FileHandle, whose
// byte-range fragment cache already handles partial reads.
//
// Write side: puterfs has no partial-write or append api — every write is a
// whole-file upload — so a WriteStream buffers through a FileHandle and flushes
// once on close. Two consequences worth knowing: nothing is visible in puterfs
// until the stream closes, and the entire payload is held in memory until then.

import nodeBuffer from "../buffer";
import { decode, fetchPuterStream } from "../../puter";
import { FileHandle } from "./handle";
import { fdTable } from "./fd-table";
import { normalizePath, translatePuterError } from "./util";
import { registerStreamCtors } from "./stream-registry";
// Not `nodeStream.Readable`/`.Writable` directly: see ./lazy-base.ts for why the
// fs subgraph can't read a `node/*` barrel at module scope.
import { ReadableBase, WritableBase } from "./lazy-base";

type NodeFs = typeof import("node:fs");

let Buffer = nodeBuffer.Buffer;

// node's default for fs streams, and the read size we ask the FileHandle for.
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

interface CommonOptions {
	flags?: string;
	encoding?: BufferEncoding;
	fd?: number | FileHandle | any;
	mode?: number;
	autoClose?: boolean;
	emitClose?: boolean;
	start?: number;
	end?: number;
	highWaterMark?: number;
	signal?: AbortSignal;
}

function normalizeOptions(options: any): CommonOptions {
	if (typeof options === "string")
		return { encoding: options as BufferEncoding };
	return options ?? {};
}

// `options.fd` accepts a number (looked up in the shared fd table) or a
// FileHandle, same as node. An fd from the *sync* family lives in the same table
// but isn't a FileHandle, so it resolves to undefined and the stream falls back
// to the path.
function handleFromOption(fd: unknown): FileHandle | undefined {
	if (fd === undefined || fd === null) return undefined;
	if (fd instanceof FileHandle) return fd;
	if (typeof fd === "number") {
		let entry = fdTable.get(fd);
		return entry instanceof FileHandle ? entry : undefined;
	}
	if (typeof fd === "object" && "fd" in (fd as any)) {
		let entry = fdTable.get((fd as any).fd);
		return entry instanceof FileHandle ? entry : undefined;
	}
	return undefined;
}

async function readErrorFor(res: Response, path: string): Promise<Error> {
	let body: any;
	try {
		body = decode(new Uint8Array(await res.arrayBuffer()));
	} catch {
		body = undefined;
	}
	return (
		translatePuterError(body?.code, "read", path) ??
		new Error(body?.message ?? `read failed with status ${res.status}`)
	);
}

export class ReadStream extends ReadableBase {
	path: string | undefined;
	bytesRead = 0;
	/** null until the backing handle is open, as in node. */
	fd: number | null = null;

	#handle: FileHandle | undefined;
	/** Whether we opened `#handle` ourselves and therefore own closing it. */
	#ownsHandle = false;
	#autoClose: boolean;
	#start: number;
	#end: number;
	#position: number;
	#chunkSize: number;
	#signal: AbortSignal | undefined;
	#reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	#release: (() => void) | undefined;
	/** Tail of a network chunk that overran the requested read size. */
	#leftover: Buffer | undefined;
	/** true when the body arrives over one streamed GET rather than the handle. */
	#streamed: boolean;

	constructor(pathLike: any, options?: any) {
		let opts = normalizeOptions(options);
		super({
			highWaterMark: opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
			encoding: opts.encoding,
			emitClose: opts.emitClose !== false,
			autoDestroy: true,
		});

		let existing = handleFromOption(opts.fd);
		this.#handle = existing;
		this.#autoClose = opts.autoClose !== false;
		this.#start = opts.start ?? 0;
		// node's `end` is inclusive; Infinity means "to EOF".
		this.#end = opts.end ?? Infinity;
		this.#position = this.#start;
		this.#chunkSize = opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
		this.#signal = opts.signal;

		if (existing) {
			// The caller may have written through this handle; its buffered state is
			// the truth, so read through it rather than re-fetching.
			this.path = undefined;
			this.#streamed = false;
			this.fd = existing.fd;
		} else {
			this.path = normalizePath(pathLike);
			// One request either way: a `start`/`end` window is just a Range header
			// on the same GET, rather than a ranged read per chunk.
			this.#streamed = true;
		}

		if (opts.signal) {
			let onAbort = () =>
				this.destroy(
					Object.assign(new Error("The operation was aborted"), {
						name: "AbortError",
						code: "ABORT_ERR",
					})
				);
			if (opts.signal.aborted) queueMicrotask(onAbort);
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	get pending(): boolean {
		return this.fd === null;
	}

	_construct(callback: (err?: Error | null) => void): void {
		if (this.#handle) {
			// Already open; 'open' is not emitted for a caller-supplied fd, matching
			// node's FileHandle-backed streams.
			this.emit("ready");
			callback();
			return;
		}

		let path = this.path!;
		// Opening the handle and starting the body fetch concurrently keeps this to
		// one round trip: the open exists to produce a real fd (so `stream.fd`,
		// 'open' and fs.close(fd) all behave) and to surface ENOENT/EACCES before
		// any data flows, not to move bytes.
		let open = FileHandle.open(path, "r").then((handle) => {
			this.#handle = handle;
			this.#ownsHandle = true;
			this.fd = handle.fd;
		});
		let body = this.#streamed
			? this.#openStreamedBody(path)
			: Promise.resolve();

		Promise.all([open, body]).then(
			() => {
				this.emit("open", this.fd);
				this.emit("ready");
				callback();
			},
			(err) => callback(err as Error)
		);
	}

	async #openStreamedBody(path: string) {
		// `?offset=&byte_count=` is NOT usable here — the api ignores those and
		// returns the whole file. See `readRange` in ./handle.ts.
		let ranged = this.#start !== 0 || this.#end !== Infinity;
		let headers = ranged
			? {
					Range: `bytes=${this.#start}-${this.#end === Infinity ? "" : this.#end}`,
				}
			: undefined;

		let [ok, res, release] = await fetchPuterStream(
			`read?file=${encodeURIComponent(path)}`,
			this.#signal,
			headers
		);
		this.#release = release;

		if (!ok) {
			// 416 means `start` is at or past EOF: node's createReadStream yields no
			// data for that rather than erroring.
			if (res.status === 416) {
				release();
				this.#release = undefined;
				return;
			}
			let err = await readErrorFor(res, path);
			release();
			this.#release = undefined;
			throw err;
		}
		if (!res.body) {
			// An empty body is a legitimate zero-byte file.
			release();
			this.#release = undefined;
			return;
		}

		// A 200 for a ranged request means the server ignored the Range; trim
		// client-side so the window is still honored.
		if (ranged && res.status !== 206) {
			let all = Buffer.from(new Uint8Array(await res.arrayBuffer()));
			release();
			this.#release = undefined;
			let end = this.#end === Infinity ? all.length : this.#end + 1;
			this.#leftover = all.subarray(this.#start, end) as Buffer;
			return;
		}

		this.#reader = res.body.getReader();
	}

	_read(size: number): void {
		this.#pull(size || this.#chunkSize).then(
			(chunk) => {
				if (chunk === null) {
					this.push(null);
					return;
				}
				this.bytesRead += chunk.length;
				this.push(chunk);
			},
			(err) => this.destroy(err as Error)
		);
	}

	async #pull(size: number): Promise<Buffer | null> {
		if (this.#streamed) return this.#pullStreamed(size);

		let remaining =
			this.#end === Infinity ? size : this.#end - this.#position + 1;
		if (remaining <= 0) return null;

		let want = Math.min(size, remaining);
		let buffer = Buffer.alloc(want);
		let { bytesRead } = await this.#handle!.read(
			buffer as unknown as NodeJS.ArrayBufferView,
			0,
			want,
			this.#position
		);
		if (bytesRead === 0) return null;
		this.#position += bytesRead;
		return buffer.subarray(0, bytesRead) as Buffer;
	}

	async #pullStreamed(size: number): Promise<Buffer | null> {
		// Network chunks have nothing to do with highWaterMark, so hand back at
		// most `size` and keep the tail. Without this a single large response is
		// pushed as one oversized chunk and backpressure means nothing.
		if (this.#leftover) {
			let chunk = this.#leftover;
			if (chunk.length <= size) {
				this.#leftover = undefined;
				return chunk;
			}
			this.#leftover = chunk.subarray(size) as Buffer;
			return chunk.subarray(0, size) as Buffer;
		}
		if (!this.#reader) return null;

		let { done, value } = await this.#reader.read();
		if (done || !value) {
			this.#reader = undefined;
			this.#release?.();
			this.#release = undefined;
			return null;
		}
		let chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		if (chunk.length <= size) return chunk;
		this.#leftover = chunk.subarray(size) as Buffer;
		return chunk.subarray(0, size) as Buffer;
	}

	_destroy(err: Error | null, callback: (err?: Error | null) => void): void {
		// Cancelling the body matters: an abandoned reader keeps the response (and
		// the keepalive ref behind it) alive.
		let cancel = this.#reader
			? this.#reader.cancel().catch(() => undefined)
			: Promise.resolve();
		this.#reader = undefined;

		this.#leftover = undefined;
		cancel
			.then(() => {
				this.#release?.();
				this.#release = undefined;
				if (this.#autoClose && this.#ownsHandle && this.#handle) {
					return this.#handle.close();
				}
			})
			.then(
				() => callback(err),
				(closeErr) => callback(err ?? (closeErr as Error))
			);
	}

	close(callback?: (err?: Error | null) => void): void {
		if (callback) this.once("close", () => callback(null));
		this.destroy();
	}
}

export class WriteStream extends WritableBase {
	path: string | undefined;
	bytesWritten = 0;
	fd: number | null = null;

	#handle: FileHandle | undefined;
	#ownsHandle = false;
	#autoClose: boolean;
	#flags: string;
	/** Explicit write offset when `start` was given; null means "handle position". */
	#position: number | null;

	constructor(pathLike: any, options?: any) {
		let opts = normalizeOptions(options);
		super({
			highWaterMark: opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
			decodeStrings: false,
			defaultEncoding: opts.encoding,
			emitClose: opts.emitClose !== false,
			autoDestroy: true,
		});

		let existing = handleFromOption(opts.fd);
		this.#handle = existing;
		this.#autoClose = opts.autoClose !== false;
		this.#flags = opts.flags ?? "w";
		this.#position = opts.start ?? null;

		if (existing) {
			this.path = undefined;
			this.fd = existing.fd;
		} else {
			this.path = normalizePath(pathLike);
		}

		if (opts.signal) {
			let onAbort = () =>
				this.destroy(
					Object.assign(new Error("The operation was aborted"), {
						name: "AbortError",
						code: "ABORT_ERR",
					})
				);
			if (opts.signal.aborted) queueMicrotask(onAbort);
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	get pending(): boolean {
		return this.fd === null;
	}

	_construct(callback: (err?: Error | null) => void): void {
		if (this.#handle) {
			this.emit("ready");
			callback();
			return;
		}

		FileHandle.open(this.path!, this.#flags).then(
			(handle) => {
				this.#handle = handle;
				this.#ownsHandle = true;
				this.fd = handle.fd;
				this.emit("open", this.fd);
				this.emit("ready");
				callback();
			},
			(err) => callback(err as Error)
		);
	}

	#writeChunk(chunk: any, encoding: BufferEncoding): Promise<number> {
		let buf: Buffer = Buffer.isBuffer(chunk)
			? chunk
			: typeof chunk === "string"
				? Buffer.from(chunk, encoding)
				: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

		return this.#handle!.write(
			buf as unknown as NodeJS.ArrayBufferView,
			0,
			buf.byteLength,
			this.#position
		).then(({ bytesWritten }) => {
			if (this.#position !== null) this.#position += bytesWritten;
			this.bytesWritten += bytesWritten;
			return bytesWritten;
		});
	}

	_write(
		chunk: any,
		encoding: BufferEncoding,
		callback: (err?: Error | null) => void
	): void {
		this.#writeChunk(chunk, encoding).then(
			() => callback(),
			(err) => callback(err as Error)
		);
	}

	_writev(
		chunks: Array<{ chunk: any; encoding: BufferEncoding }>,
		callback: (err?: Error | null) => void
	): void {
		(async () => {
			for (let { chunk, encoding } of chunks) {
				await this.#writeChunk(chunk, encoding);
			}
		})().then(
			() => callback(),
			(err) => callback(err as Error)
		);
	}

	_final(callback: (err?: Error | null) => void): void {
		// This is the upload. Everything before it only touched the handle's
		// in-memory buffer.
		if (!this.#handle) return callback();
		this.#handle.sync().then(
			() => callback(),
			(err) => callback(err as Error)
		);
	}

	_destroy(err: Error | null, callback: (err?: Error | null) => void): void {
		let close =
			this.#autoClose && this.#ownsHandle && this.#handle
				? this.#handle.close()
				: Promise.resolve();
		close.then(
			() => callback(err),
			(closeErr) => callback(err ?? (closeErr as Error))
		);
	}

	close(callback?: (err?: Error | null) => void): void {
		if (callback) this.once("close", () => callback(null));
		this.end();
	}
}

export let createReadStream = ((path: any, options?: any) =>
	new ReadStream(path, options)) as unknown as NodeFs["createReadStream"];

export let createWriteStream = ((path: any, options?: any) =>
	new WriteStream(path, options)) as unknown as NodeFs["createWriteStream"];

// Hands the constructors to FileHandle without giving ./handle.ts an import edge
// back to this module; see ./stream-registry.ts.
registerStreamCtors({ ReadStream, WriteStream });
