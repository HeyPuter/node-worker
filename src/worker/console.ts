import { buffer as nodeBuffer, stream as nodeStream } from "./node/polyfills";

let isTTY: boolean;

let stdin: ReadableStream<Uint8Array<ArrayBuffer>>;
let stdout: SharedWriter<Uint8Array<ArrayBuffer>>;
let stderr: SharedWriter<Uint8Array<ArrayBuffer>>;

export let stdinStream: InstanceType<typeof nodeStream.Readable>;
export let stdoutStream: InstanceType<typeof nodeStream.Writable>;
export let stderrStream: InstanceType<typeof nodeStream.Writable>;

type SharedWriter<T> = {
	write(chunk: T): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
};

function makeSharedWriter<T>(writable: WritableStream<T>): SharedWriter<T> {
	const writer = writable.getWriter();

	let tail: Promise<void> = Promise.resolve();
	let closed = false;

	return {
		async write(chunk: T): Promise<void> {
			if (closed) {
				throw new TypeError("shared writer is closed");
			}

			const result = tail.then(async () => {
				await writer.ready;
				await writer.write(chunk);
			});

			tail = result.catch(() => {});
			return result;
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;

			const result = tail.then(() => writer.close());
			tail = result.catch(() => {});

			return result.finally(() => {
				writer.releaseLock();
			});
		},

		async abort(reason?: unknown): Promise<void> {
			if (closed) return;
			closed = true;

			try {
				await writer.abort(reason);
			} finally {
				writer.releaseLock();
			}
		},
	};
}

function attachTTYGetter(stream: object) {
	Object.defineProperty(stream, "isTTY", {
		configurable: true,
		enumerable: true,
		get() {
			return isTTY;
		},
	});
}

function makeReadableStream(): InstanceType<typeof nodeStream.Readable> {
	let reading = false;
	let ended = false;

	let stream = new nodeStream.Readable({
		read() {
			if (reading || ended) {
				return;
			}

			reading = true;
			let reader = stdin.getReader();

			void (async () => {
				try {
					while (!stream.destroyed) {
						let { done, value } = await reader.read();
						if (done) {
							ended = true;
							stream.push(null);
							return;
						}
						if (!value) {
							continue;
						}

						if (!stream.push(nodeBuffer.Buffer.from(value))) {
							return;
						}
					}
				} catch (error) {
					stream.destroy(error as Error);
				} finally {
					reading = false;
					reader.releaseLock();
				}
			})();
		},
	});

	(stream as typeof stream & { fd?: number }).fd = 0;
	attachTTYGetter(stream);
	return stream;
}

function toUint8Array(
	chunk: string | ArrayBufferView | ArrayBuffer,
	encoding: BufferEncoding
): Uint8Array<ArrayBuffer> {
	if (typeof chunk === "string") {
		return Uint8Array.from(nodeBuffer.Buffer.from(chunk, encoding));
	}

	if (chunk instanceof ArrayBuffer) {
		return new Uint8Array(chunk.slice(0));
	}

	if (ArrayBuffer.isView(chunk)) {
		return Uint8Array.from(
			new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
		);
	}

	throw new TypeError("unsupported stdio chunk type");
}

function makeWritableStream(
	writer: SharedWriter<Uint8Array<ArrayBuffer>>,
	fd: number
): InstanceType<typeof nodeStream.Writable> {
	let stream = new nodeStream.Writable({
		write(chunk, encoding, callback) {
			writer
				.write(
					toUint8Array(
						chunk as string | ArrayBufferView | ArrayBuffer,
						encoding
					)
				)
				.then(
					() => callback(),
					(error) => callback(error as Error)
				);
		},
		final(callback) {
			writer.close().then(
				() => callback(),
				(error) => callback(error as Error)
			);
		},
		destroy(error, callback) {
			writer.abort(error ?? undefined).then(
				() => callback(error),
				(abortError) => callback(abortError as Error)
			);
		},
	});

	(stream as typeof stream & { fd?: number }).fd = fd;
	attachTTYGetter(stream);
	return stream;
}

function serializeConsoleValue(val: any): string {
	if (typeof val === "string") {
		return val;
	}
	// TODO make this nodelike
	return JSON.stringify(val);
}

let encoder = new TextEncoder();
type ConsoleFunc = "debug" | "log" | "info" | "warn" | "error";
function proxyConsole<T extends ConsoleFunc>(
	stream: SharedWriter<Uint8Array<ArrayBuffer>>,
	prop: T
): (typeof console)[T] {
	let orig = console[prop];
	console[prop] = new Proxy(orig, {
		apply(target, thisArg, argArray) {
			Reflect.apply(target, thisArg, argArray);

			stream.write(
				encoder.encode(argArray.map(serializeConsoleValue).join(" ") + "\r\n")
			);
		},
	});
	return orig;
}

export let console_debug = console.debug;
export let console_log = console.log;
export let console_info = console.info;
export let console_warn = console.warn;
export let console_error = console.error;

export interface ConsoleSettings {
	stdin: ReadableStream<Uint8Array<ArrayBuffer>>;
	stdout: WritableStream<Uint8Array<ArrayBuffer>>;
	stderr: WritableStream<Uint8Array<ArrayBuffer>>;
	isTTY: boolean;
}

export function initConsole(settings: ConsoleSettings) {
	stdin = settings.stdin;
	stdout = makeSharedWriter(settings.stdout);
	stderr = makeSharedWriter(settings.stderr);
	isTTY = settings.isTTY;
	stdinStream = makeReadableStream();
	stdoutStream = makeWritableStream(stdout, 1);
	stderrStream = makeWritableStream(stderr, 2);

	console_debug = proxyConsole(stdout, "debug");
	console_log = proxyConsole(stdout, "log");
	console_info = proxyConsole(stdout, "info");
	console_warn = proxyConsole(stderr, "warn");
	console_error = proxyConsole(stderr, "error");
}

export function setIsTTY(istty: boolean) {
	isTTY = istty;
}
