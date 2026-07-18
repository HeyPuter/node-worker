import { send } from "./conn";
import nodeBuffer from "./node/buffer";
import nodeStream from "./node/stream";
import nodeProcess from "./node/process";

let isTTY = true;
let isRaw = false;

export function setIsTTY(IsTTY: boolean) {
	isTTY = IsTTY;
}

export interface TTYStateChange {
	isRaw?: boolean;
	echo?: boolean;
}

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

const stdinBridge = new TransformStream<
	Uint8Array<ArrayBuffer>,
	Uint8Array<ArrayBuffer>
>();
const stdoutBridge = new TransformStream<
	Uint8Array<ArrayBuffer>,
	Uint8Array<ArrayBuffer>
>();
const stderrBridge = new TransformStream<
	Uint8Array<ArrayBuffer>,
	Uint8Array<ArrayBuffer>
>();

let stdinQueueWriter = makeSharedWriter(stdinBridge.writable);
let stdout = makeSharedWriter(stdoutBridge.writable);
let stderr = makeSharedWriter(stderrBridge.writable);

let stdinForwardStarted = false;
let stdoutForwardStarted = false;
let stderrForwardStarted = false;

async function forwardToWriter(
	readable: ReadableStream<Uint8Array<ArrayBuffer>>,
	writer: SharedWriter<Uint8Array<ArrayBuffer>>
) {
	let reader = readable.getReader();
	try {
		while (true) {
			let { done, value } = await reader.read();
			if (done) {
				await writer.close();
				return;
			}
			if (!value) {
				continue;
			}

			await writer.write(value);
		}
	} catch (error) {
		await writer.abort(error);
	} finally {
		reader.releaseLock();
	}
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

async function emitTTYStateChange(change: TTYStateChange) {
	await send("tty", { isRaw: change.isRaw, echo: change.echo });
}

// Node's tty.WriteStream exposes getColorDepth()/hasColors(); console's
// `shouldColorize` consults getColorDepth() to enable ANSI output. We report
// 24-bit truecolor while a TTY (xterm renders ANSI) and monochrome otherwise,
// so colorization tracks the TTY state set via setIsTTY().
function attachColorCapabilities(stream: object) {
	Object.defineProperty(stream, "getColorDepth", {
		configurable: true,
		enumerable: true,
		value() {
			return isTTY ? 24 : 1;
		},
	});

	Object.defineProperty(stream, "hasColors", {
		configurable: true,
		enumerable: true,
		value(count?: number) {
			if (!isTTY) return false;
			return count === undefined ? true : count <= 2 ** 24;
		},
	});
}

function attachTTYControl(stream: object) {
	Object.defineProperty(stream, "isRaw", {
		configurable: true,
		enumerable: true,
		get() {
			return isRaw;
		},
	});

	Object.defineProperty(stream, "setRawMode", {
		configurable: true,
		enumerable: true,
		value(mode: boolean) {
			let next = !!mode;
			let prev = isRaw;
			isRaw = next;
			emitTTYStateChange({ isRaw, echo: !isRaw });
			return prev;
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
			let reader = stdinBridge.readable.getReader();

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
	attachTTYControl(stream);
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
	attachColorCapabilities(stream);
	return stream;
}


// Snapshot the worker's native (devtools) console methods before anything
// installs the Node `console` global (module/globals.ts does that, but it is
// imported after this module — see module/cjs.ts). Internal worker code logs
// through these so its output reaches devtools instead of the user program's
// stdout/stderr. User-facing `console.*` is the real Node console, which writes
// only to process.stdout/stderr (module/node/console.ts).
export let console_debug = console.debug.bind(console);
export let console_log = console.log.bind(console);
export let console_info = console.info.bind(console);
export let console_warn = console.warn.bind(console);
export let console_error = console.error.bind(console);

export interface ConsoleSettings {
	stdin: ReadableStream<Uint8Array<ArrayBuffer>>;
	stdout: WritableStream<Uint8Array<ArrayBuffer>>;
	stderr: WritableStream<Uint8Array<ArrayBuffer>>;
	isTTY: boolean;
}

export function initConsole(settings: ConsoleSettings) {
	isTTY = settings.isTTY;
	isRaw = false;

	// Deferred from module-init: nodeStream's CJS wrapper hasn't run yet at
	// our top-level, so `new nodeStream.Readable()` would throw.
	if (!stdinStream) {
		stdinStream = makeReadableStream();
		stdoutStream = makeWritableStream(stdout, 1);
		stderrStream = makeWritableStream(stderr, 2);
		nodeProcess.stdin = stdinStream as any;
		nodeProcess.stdout = stdoutStream as any;
		nodeProcess.stderr = stderrStream as any;
	}

	if (!stdinForwardStarted) {
		stdinForwardStarted = true;
		void forwardToWriter(settings.stdin, stdinQueueWriter);
	}
	if (!stdoutForwardStarted) {
		stdoutForwardStarted = true;
		void forwardToWriter(
			stdoutBridge.readable,
			makeSharedWriter(settings.stdout)
		);
	}
	if (!stderrForwardStarted) {
		stderrForwardStarted = true;
		void forwardToWriter(
			stderrBridge.readable,
			makeSharedWriter(settings.stderr)
		);
	}
}
