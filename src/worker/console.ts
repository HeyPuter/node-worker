let isTTY: boolean;

let stdin: ReadableStream<Uint8Array<ArrayBuffer>>;
let stdout: SharedWriter<Uint8Array<ArrayBuffer>>;
let stderr: SharedWriter<Uint8Array<ArrayBuffer>>;

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

			tail = result.catch(() => { });
			return result;
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;

			const result = tail.then(() => writer.close());
			tail = result.catch(() => { });

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

function serializeConsoleValue(val: any): string {
	if (typeof val === "string") {
		return val;
	}
	// TODO make this nodelike;
	return JSON.stringify(val);
}

let encoder = new TextEncoder();
type ConsoleFunc = "debug" | "log" | "info" | "warn" | "error";
function proxyConsole<T extends ConsoleFunc>(stream: SharedWriter<Uint8Array<ArrayBuffer>>, prop: T): typeof console[T] {
	let orig = console[prop];
	console[prop] = new Proxy(orig, {
		apply(target, thisArg, argArray) {
			Reflect.apply(target, thisArg, argArray);

			stream.write(encoder.encode(argArray.map(serializeConsoleValue).join(" ") + "\r\n"));
		}
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

	console_debug = proxyConsole(stdout, "debug");
	console_log = proxyConsole(stdout, "log");
	console_info = proxyConsole(stdout, "info");
	console_warn = proxyConsole(stderr, "warn");
	console_error = proxyConsole(stderr, "error");
}

export function setIsTTY(istty: boolean) {
	isTTY = istty;
}
