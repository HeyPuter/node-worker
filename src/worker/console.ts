import { send } from "./conn";
import nodeBuffer from "./node/buffer";
import nodeStream from "./node/stream";
import nodeProcess from "./node/process";
import * as keepalive from "./keepalive";
import { setExitFlusher } from "./exit";

let isTTY = true;
let isRaw = false;

// Terminal dimensions, as `tty.WriteStream.columns`/`rows`.
//
// 80x24 until the host says otherwise, because a CLI reaching for `columns` gets a
// number either way: vite's build progress does `output.length < process.stdout.columns`
// and then `substring(0, columns - 1)`, so `undefined` there does not throw — it
// silently writes the empty string and the build appears to produce no output at all.
let columns = 80;
let rows = 24;

export function setIsTTY(IsTTY: boolean) {
	isTTY = IsTTY;
}

export function setTTYSize(size: { columns?: number; rows?: number }) {
	if (size.columns && size.columns > 0) columns = Math.floor(size.columns);
	if (size.rows && size.rows > 0) rows = Math.floor(size.rows);
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
	/** Settles once every write queued so far has completed. */
	flush(): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
};

/**
 * Chunk counters for one direction of the console.
 *
 * `queued` counts what a program handed to `process.stdout`; `forwarded` counts what has
 * actually been written to the stream the page holds. They are the only way to tell
 * "the program's output is all across the boundary" from "some of it is still sitting in
 * a queue in here" — which is the difference between a terminal showing a build's summary
 * and swallowing it.
 */
type Meter = { queued: number; forwarded: number };

const stdoutMeter: Meter = { queued: 0, forwarded: 0 };
const stderrMeter: Meter = { queued: 0, forwarded: 0 };

/** Captured before anything can wrap it, so a flush cannot be kept alive by its own wait. */
const realSetTimeout = globalThis.setTimeout;

function nextMacrotask(): Promise<void> {
	return new Promise<void>((r) => realSetTimeout(r, 0));
}

function makeSharedWriter<T>(
	writable: WritableStream<T>,
	meter?: Meter
): SharedWriter<T> {
	const writer = writable.getWriter();

	let tail: Promise<void> = Promise.resolve();
	let closed = false;

	return {
		flush(): Promise<void> {
			return tail;
		},

		async write(chunk: T): Promise<void> {
			if (closed) {
				throw new TypeError("shared writer is closed");
			}
			if (meter) meter.queued += 1;

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
let stdout = makeSharedWriter(stdoutBridge.writable, stdoutMeter);
let stderr = makeSharedWriter(stderrBridge.writable, stderrMeter);

/** The writers onto the page's streams, kept so a flush can await their queues. */
let outboundStdout: SharedWriter<Uint8Array<ArrayBuffer>> | undefined;
let outboundStderr: SharedWriter<Uint8Array<ArrayBuffer>> | undefined;

let stdinForwardStarted = false;
let stdoutForwardStarted = false;
let stderrForwardStarted = false;

async function forwardToWriter(
	readable: ReadableStream<Uint8Array<ArrayBuffer>>,
	writer: SharedWriter<Uint8Array<ArrayBuffer>>,
	meter?: Meter
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
			if (meter) meter.forwarded += 1;
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

// The cursor half of node's tty.WriteStream: `columns`, `rows`, and the four movement
// helpers, each emitting the ANSI sequence node's readline would.
//
// Node only puts these on a stream that *is* a TTY, and a CLI is supposed to check
// `isTTY` first. Plenty do not — vite's build has both a guarded `clearLine()` and an
// unguarded one — so a missing method surfaces as `process.stdout.clearLine is not a
// function` in the middle of an otherwise working build. Providing them
// unconditionally costs nothing: when the output is not a terminal the sequences are
// inert bytes, which is the same thing a redirected TTY write would be.
function attachCursorControl(stream: object) {
	let define = (name: string, value: unknown) =>
		Object.defineProperty(stream, name, {
			configurable: true,
			enumerable: true,
			value,
		});

	for (let [name, get] of [
		["columns", () => columns],
		["rows", () => rows],
	] as const) {
		Object.defineProperty(stream, name, {
			configurable: true,
			enumerable: true,
			get,
		});
	}

	// Every one of these takes an optional callback and returns true, as node's do:
	// there is no backpressure to report because the write is already queued.
	let emit = (sequence: string, callback?: () => void) => {
		(stream as any).write(sequence);
		callback?.();
		return true;
	};

	define("getWindowSize", () => [columns, rows]);

	define("clearLine", (dir: number, callback?: () => void) =>
		// -1 to the cursor, 1 from the cursor, 0 the whole line.
		emit(dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K", callback)
	);

	define("clearScreenDown", (callback?: () => void) => emit("\x1b[0J", callback));

	define("cursorTo", (x: number, y?: number | (() => void), callback?: () => void) => {
		// node allows cursorTo(x, cb) as well as cursorTo(x, y, cb).
		if (typeof y === "function") {
			callback = y;
			y = undefined;
		}
		let column = Math.max(0, Math.floor(x)) + 1;
		if (y === undefined) return emit(`\x1b[${column}G`, callback);
		return emit(`\x1b[${Math.max(0, Math.floor(y)) + 1};${column}H`, callback);
	});

	define("moveCursor", (dx: number, dy: number, callback?: () => void) => {
		let sequence = "";
		if (dy < 0) sequence += `\x1b[${-dy}A`;
		else if (dy > 0) sequence += `\x1b[${dy}B`;
		if (dx > 0) sequence += `\x1b[${dx}C`;
		else if (dx < 0) sequence += `\x1b[${-dx}D`;
		return emit(sequence, callback);
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
	let paused = false;
	let userUnrefed = false;
	let refed = false;

	// Mirror libuv's readStart/readStop + ref semantics for stdin. In Node the
	// process stays alive while `process.stdin` is an active, refed handle: the
	// stream is actively reading (a consumer wants data), it is not paused, and
	// it has not been `.unref()`ed. This is what keeps a TUI (e.g. an agent CLI)
	// alive while it sits at an idle prompt blocked on a keypress with no pending
	// timers. Without it the ref count hits zero and `drain()` settles the run
	// prematurely. `reading` tracks readStart/readStop, the pause/resume/end/
	// close listeners below track flowing state, and ref()/unref() the manual
	// override.
	function syncKeepalive() {
		let want = reading && !paused && !ended && !userUnrefed;
		if (want === refed) return;
		refed = want;
		if (refed) keepalive.ref();
		else keepalive.unref();
	}

	let stream = new nodeStream.Readable({
		read() {
			if (reading || ended) {
				return;
			}

			reading = true;
			syncKeepalive();
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
					syncKeepalive();
					reader.releaseLock();
				}
			})();
		},
	});

	// A paused stream is not a live read handle; ending/closing it retires the
	// handle for good. Track both so the ref count follows the stream's state.
	stream.on("pause", () => {
		paused = true;
		syncKeepalive();
	});
	stream.on("resume", () => {
		paused = false;
		syncKeepalive();
	});
	stream.on("end", () => {
		ended = true;
		syncKeepalive();
	});
	stream.on("close", () => {
		ended = true;
		syncKeepalive();
	});

	// Node's process.stdin is a Socket/ReadStream, so it exposes ref/unref;
	// programs that want the run to be able to exit while still occasionally
	// reading stdin rely on `process.stdin.unref()`.
	(stream as any).ref = function () {
		userUnrefed = false;
		syncKeepalive();
		return stream;
	};
	(stream as any).unref = function () {
		userUnrefed = true;
		syncKeepalive();
		return stream;
	};

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
	attachCursorControl(stream);
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
		outboundStdout = makeSharedWriter(settings.stdout);
		void forwardToWriter(stdoutBridge.readable, outboundStdout, stdoutMeter);
	}
	if (!stderrForwardStarted) {
		stderrForwardStarted = true;
		outboundStderr = makeSharedWriter(settings.stderr);
		void forwardToWriter(stderrBridge.readable, outboundStderr, stderrMeter);
	}

	// So `process.exit` can get the program's output out before the page, which
	// terminates this worker on hearing about the exit, has a chance to.
	setExitFlusher(flushConsole);
}

/**
 * Settle once everything written to stdout and stderr has crossed to the page.
 *
 * This has to exist because the two are decoupled: `console.log` returns as soon as the
 * bytes are queued, and they then travel through a bridge and a serialized writer to reach
 * the streams the page holds. A worker terminated in between loses whatever had not made
 * it — which for a program that prints a burst and returns is *almost all of it*. Measured
 * before this existed: a run printing 200 lines delivered 3.
 *
 * Awaiting the queues alone is not enough, hence the counters. When the inner writer's
 * tail settles, every chunk is in the bridge, but the loop draining the bridge has its own
 * backpressure and may be several chunks behind; `queued === forwarded` is what says it has
 * caught up.
 */
export async function flushConsole(): Promise<void> {
	let settled = async () => {
		await stdout.flush();
		await stderr.flush();
		await outboundStdout?.flush();
		await outboundStderr?.flush();
	};

	// Bounded by lack of *progress*, not by a pass count. A fixed cap silently becomes a
	// limit on how much a program may print — at ~2 chunks forwarded per turn, a 500-pass
	// cap truncated a 2000-line run at line 1006. Giving up only when nothing moved for
	// many consecutive turns keeps the guard (a page that stopped reading cannot hang the
	// run) without bounding the output.
	let stalled = 0;
	let lastForwarded = -1;
	while (stalled < 100) {
		await settled();
		if (
			stdoutMeter.queued === stdoutMeter.forwarded &&
			stderrMeter.queued === stderrMeter.forwarded
		) {
			return;
		}
		let forwarded = stdoutMeter.forwarded + stderrMeter.forwarded;
		stalled = forwarded === lastForwarded ? stalled + 1 : 0;
		lastForwarded = forwarded;
		await nextMacrotask();
	}
}
