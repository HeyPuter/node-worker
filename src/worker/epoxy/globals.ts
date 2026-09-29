import { getClient } from "./index";
import { platformPrimordials as p } from "../platform-primordials";
import { nodePrimordials as nodeP } from "../node-primordials";
import * as keepalive from "../keepalive";
import type {
	EpoxyWSChunk,
	EpoxyWSCloseInfo,
	EpoxyRawHeaders,
} from "./epoxy-wasm";

interface EpoxyWS {
	readable: ReadableStream<EpoxyWSChunk>;
	writable: WritableStream<EpoxyWSChunk>;
	protocol: string;
	headers: Headers;
	rawHeaders: EpoxyRawHeaders;
	closed: Promise<EpoxyWSCloseInfo>;
	close(info?: EpoxyWSCloseInfo): void;
}

type WebSocketStreamOpen = {
	extensions: string;
	protocol: string;
	readable: ReadableStream<EpoxyWSChunk>;
	writable: WritableStream<EpoxyWSChunk>;
};
type WebSocketStreamClose = {
	closeCode?: number;
	reason?: string;
};
type WebSocketStreamOptions = {
	protocols?: string | string[];
	headers?: HeadersInit;
	signal?: AbortSignal;
};
type WebSocketStreamConstructor = new (
	url: string | URL,
	options?: WebSocketStreamOptions
) => WebSocketStreamLike;

interface WebSocketStreamLike {
	readonly url: string;
	readonly opened: Promise<WebSocketStreamOpen>;
	readonly closed: Promise<WebSocketStreamClose>;
	close(closeInfo?: WebSocketStreamClose): void;
}

export const FETCH = p.fetch;

/**
 * The real `XMLHttpRequest`, captured before it is hidden from user code.
 *
 * The synchronous `fs` transport dials the service worker with a blocking XHR
 * (node/fs/transport.ts), so the constructor has to stay reachable *here*. It must not stay
 * reachable from a program, for two reasons.
 *
 * Node has no global `XMLHttpRequest`, and a great many libraries test exactly that to decide
 * whether they are running in a browser. axios is the one that bit: its adapter list is
 * `["xhr", "http", "fetch"]` and it takes the first *supported* entry, so the mere presence of XHR
 * made it choose the browser adapter — which issues a real cross-origin request that never enters
 * the wisp tunnel and dies on CORS as `ERR_NETWORK`, while the same program's `fetch` calls were
 * working perfectly.
 *
 * And unlike `fetch` and `WebSocket`, this one is not worth re-implementing over epoxy: anything
 * reaching for XHR inside a Node runtime has an http/fetch path it would rather be on, and handing
 * it a working XHR would only keep it on the wrong one.
 */
export const NATIVE_XHR = p.XMLHttpRequest;

function emit(
	target: EventTarget,
	event: Event,
	handler?: ((event: any) => void) | null
) {
	p.eventTargetDispatchEvent(target, event);
	if (handler) p.reflectApply(handler, target, [event]);
}

function toCloseEvent(info?: WebSocketStreamClose) {
	let code = info?.closeCode ?? 1000;
	return new p.CloseEvent("close", {
		code,
		reason: info?.reason ?? "",
		wasClean: code !== 1006,
	});
}

function toArrayBuffer(data: Uint8Array) {
	let buffer = new p.ArrayBuffer(data.byteLength);
	p.u8Set(new p.Uint8Array(buffer), data);
	return buffer;
}

function toMessageData(data: Uint8Array, binaryType: BinaryType) {
	if (binaryType === "arraybuffer") {
		return toArrayBuffer(data);
	}
	return new p.Blob([toArrayBuffer(data)]);
}

function normalizeProtocols(protocols?: string | string[]) {
	if (!protocols) return undefined;
	return nodeP.ArrayIsArray(protocols) ? protocols : [protocols];
}

function toWritableChunk(
	data: string | ArrayBufferLike | Blob | ArrayBufferView
) {
	if (typeof data === "string") return p.promiseResolve(data);
	if (data instanceof p.Blob)
		return p.promiseThen(
			p.blobArrayBuffer(data),
			(buffer) => new p.Uint8Array(buffer)
		);
	if (p.arrayBufferIsView(data)) {
		return p.promiseResolve(
			new p.Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		);
	}
	return p.promiseResolve(new p.Uint8Array(data));
}

function chunkSize(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
	if (typeof data === "string")
		return p.textEncoderEncode(new p.TextEncoder(), data).byteLength;
	if (data instanceof p.Blob) return data.size;
	if (p.arrayBufferIsView(data)) return data.byteLength;
	return data.byteLength;
}

class EpoxyBackedWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly CONNECTING = EpoxyBackedWebSocket.CONNECTING;
	readonly OPEN = EpoxyBackedWebSocket.OPEN;
	readonly CLOSING = EpoxyBackedWebSocket.CLOSING;
	readonly CLOSED = EpoxyBackedWebSocket.CLOSED;

	readonly url: string;
	readyState = EpoxyBackedWebSocket.CONNECTING;
	bufferedAmount = 0;
	extensions = "";
	protocol = "";
	#binaryType: BinaryType = "blob";
	#socket?: EpoxyWS;
	#writer?: WritableStreamDefaultWriter<EpoxyWSChunk>;
	onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null;
	onerror: ((this: WebSocket, ev: Event) => any) | null = null;
	onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null;
	onopen: ((this: WebSocket, ev: Event) => any) | null = null;

	constructor(url: string | URL, protocols?: string | string[]) {
		super();
		this.url = p.String(url);
		void this.#connect(protocols);
	}

	get binaryType() {
		return this.#binaryType;
	}

	set binaryType(val: BinaryType) {
		if (val === "blob" || val === "arraybuffer") this.#binaryType = val;
	}

	async #connect(protocols?: string | string[]) {
		try {
			const client = await getClient();
			let socket = await client.websocket(this.url, {
				protocols: normalizeProtocols(protocols),
			});
			if (this.readyState !== EpoxyBackedWebSocket.CONNECTING) {
				socket.close();
				return;
			}

			this.#socket = socket;
			this.#writer = p.writableGetWriter(
				socket.writable
			) as WritableStreamDefaultWriter<EpoxyWSChunk>;
			this.protocol = socket.protocol;
			this.extensions =
				p.headersGet(socket.headers, "sec-websocket-extensions") ?? "";
			this.readyState = EpoxyBackedWebSocket.OPEN;
			emit(this, new p.Event("open"), this.onopen);

			void this.#pump(socket);
		} catch (_err) {
			this.#fail();
		}
	}

	async #pump(socket: EpoxyWS) {
		try {
			let reader = p.readableGetReader(
				socket.readable
			) as ReadableStreamDefaultReader<EpoxyWSChunk>;
			while (true) {
				let { done, value } = await p.readerRead(reader);
				if (
					done ||
					value === undefined ||
					this.readyState !== EpoxyBackedWebSocket.OPEN
				) {
					break;
				}
				emit(
					this,
					new p.MessageEvent("message", {
						data:
							typeof value === "string"
								? value
								: toMessageData(value, this.binaryType),
					}),
					this.onmessage
				);
			}
		} catch (_err) {
			this.#fail();
			return;
		}

		let closeInfo = await socket.closed;
		this.#finalize(closeInfo);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
		if (this.readyState !== EpoxyBackedWebSocket.OPEN || !this.#writer) {
			throw new p.DOMException("WebSocket is not open", "InvalidStateError");
		}

		let size = chunkSize(data);
		this.bufferedAmount += size;
		void (async () => {
			try {
				await p.writerWrite(this.#writer!, await toWritableChunk(data));
			} catch (_err) {
				this.#fail();
			} finally {
				this.bufferedAmount -= size;
			}
		})();
	}

	close(code?: number, reason?: string) {
		if (
			this.readyState === EpoxyBackedWebSocket.CLOSING ||
			this.readyState === EpoxyBackedWebSocket.CLOSED
		) {
			return;
		}

		this.readyState = EpoxyBackedWebSocket.CLOSING;
		this.#socket?.close({ closeCode: code, reason });
		if (!this.#socket) this.#finalize({ closeCode: code, reason });
	}

	#fail() {
		if (this.readyState === EpoxyBackedWebSocket.CLOSED) return;
		emit(this, new p.Event("error"), this.onerror);
		this.#finalize({ closeCode: 1006 });
	}

	#finalize(closeInfo?: WebSocketStreamClose) {
		if (this.readyState === EpoxyBackedWebSocket.CLOSED) return;
		this.readyState = EpoxyBackedWebSocket.CLOSED;
		if (this.#writer) p.writerReleaseLock(this.#writer);
		emit(this, toCloseEvent(closeInfo), this.onclose);
	}
}

class EpoxyBackedWebSocketStream implements WebSocketStreamLike {
	readonly url: string;
	readonly opened: Promise<WebSocketStreamOpen>;
	readonly closed: Promise<WebSocketStreamClose>;
	#socket?: EpoxyWS;
	#closedInfo?: WebSocketStreamClose;
	#closedEarly = false;
	#abortError?: DOMException;
	#closedSettled = false;
	#closedResolve!: (value: WebSocketStreamClose) => void;
	#closedReject!: (reason?: unknown) => void;

	#resolveClosed(value: WebSocketStreamClose) {
		if (this.#closedSettled) return;
		this.#closedSettled = true;
		this.#closedResolve(value);
	}

	#rejectClosed(reason?: unknown) {
		if (this.#closedSettled) return;
		this.#closedSettled = true;
		this.#closedReject(reason);
	}

	constructor(url: string | URL, options?: WebSocketStreamOptions) {
		let _url = p.String(url);
		this.url = _url;
		this.closed = new p.Promise((resolve, reject) => {
			this.#closedResolve = resolve;
			this.#closedReject = reject;
		});

		this.opened = (async () => {
			if (options?.signal?.aborted) {
				let err = new p.DOMException("WebSocketStream aborted", "AbortError");
				this.#rejectClosed(err);
				throw err;
			}

			if (options?.signal) {
				p.eventTargetAddEventListener(
					options.signal,
					"abort",
					() => {
						let err = new p.DOMException(
							"WebSocketStream aborted",
							"AbortError"
						);
						this.#abortError = err;
						if (this.#socket) {
							this.close();
						} else {
							this.#rejectClosed(err);
						}
					},
					{ once: true }
				);
			}

			const client = await getClient();
			let socket = await client.websocket(_url, {
				protocols: normalizeProtocols(options?.protocols),
				headers: options?.headers,
			});
			if (this.#closedEarly) {
				socket.close(this.#closedInfo);
				throw new p.DOMException(
					"WebSocketStream is closed",
					"InvalidStateError"
				);
			}
			if (this.#abortError) {
				socket.close();
				throw this.#abortError;
			}
			this.#socket = socket;
			void p.promiseThen(
				socket.closed,
				(value) => this.#resolveClosed(value),
				(err) => this.#rejectClosed(err)
			);

			return {
				extensions:
					p.headersGet(socket.headers, "sec-websocket-extensions") ?? "",
				protocol: socket.protocol,
				readable: socket.readable,
				writable: socket.writable,
			};
		})();

		void p.promiseCatch(this.opened, (err) => {
			this.#rejectClosed(err);
		});
	}

	close(closeInfo?: WebSocketStreamClose) {
		if (this.#socket) {
			this.#socket.close(closeInfo);
			return;
		}
		this.#closedEarly = true;
		this.#closedInfo = closeInfo ?? {};
		this.#resolveClosed(this.#closedInfo);
	}
}

export let WebSocket =
	EpoxyBackedWebSocket as unknown as typeof globalThis.WebSocket;
export let WebSocketStream =
	EpoxyBackedWebSocketStream as unknown as WebSocketStreamConstructor;

// --- keepalive for the response body phase ---
//
// The request ref below is released when the response resolves, i.e. at headers.
// In node the socket carrying the body is a refed handle until the body ends, and
// that phase can dominate the request: an SSE/chunked stream stays open for
// minutes. Untracked, the count can sit at zero for the whole read and drain()
// settles the run mid-stream.
//
// So body consumption takes its own ref, held from the moment consumption starts
// until the body reaches a terminal state (end, error, or cancel). It is
// deliberately NOT held for a body nobody touches — that would stall drain()
// forever on a run that ignored a response. The microtask-sized handoff between
// the response resolving and the consumer's first read needs no bridging:
// drain()'s macrotask hop re-checks the count after the nextTick/microtask queues
// drain, by which point the consumer has started (see keepalive.ts).

// Mirror of the source stream that refs while it is being read. fetch bodies are
// byte streams, so this is `type: "bytes"` to keep BYOB readers
// (`getReader({ mode: "byob" })`) working. `autoAllocateChunkSize` is left unset
// so a default reader gets chunks passed straight through; only an actual BYOB
// reader pays for the copy into its view.
function refedBodyStream(
	source: ReadableStream<Uint8Array<ArrayBuffer>>
): ReadableStream<Uint8Array<ArrayBuffer>> {
	let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
	let leftover: Uint8Array<ArrayBuffer> | undefined;
	let refed = false;
	let released = false;

	let release = () => {
		if (released) return;
		released = true;
		if (refed) keepalive.unref();
	};

	// No explicit type argument: that would select ReadableStream's generic
	// overload and widen `controller` back to ReadableStreamDefaultController,
	// losing `byobRequest`.
	return new p.ReadableStream({
		type: "bytes",
		async pull(controller) {
			if (!refed && !released) {
				refed = true;
				keepalive.ref();
			}
			// Locked lazily: locking in the getter would break `.json()`/`.clone()`
			// on a response whose `body` was merely inspected, never read.
			reader ??= p.readableGetReader(source) as ReadableStreamDefaultReader<
				Uint8Array<ArrayBuffer>
			>;

			// Empty chunks have to be skipped — both `enqueue()` and
			// `byobRequest.respond(0)` throw on a zero-length view.
			let chunk = leftover;
			leftover = undefined;
			while (!chunk || chunk.byteLength === 0) {
				let result;
				try {
					result = await p.readerRead(reader);
				} catch (err) {
					release();
					controller.error(err);
					return;
				}
				if (result.done) {
					release();
					controller.close();
					// A pending BYOB request must still be answered after close().
					controller.byobRequest?.respond(0);
					return;
				}
				chunk = result.value;
			}

			let view = controller.byobRequest?.view;
			if (!view) {
				controller.enqueue(chunk);
				return;
			}

			let n = Math.min(view.byteLength, chunk.byteLength);
			p.u8Set(
				new p.Uint8Array(view.buffer, view.byteOffset, view.byteLength),
				p.u8Subarray(chunk, 0, n)
			);
			if (chunk.byteLength > n) leftover = p.u8Subarray(chunk, n);
			controller.byobRequest!.respond(n);
		},
		cancel(reason) {
			release();
			return reader
				? p.readerCancel(reader, reason)
				: p.readableCancel(source, reason);
		},
	});
}

// `.json()`/`.text()`/... read the response's internal stream directly rather
// than going through the `body` getter, so both surfaces need wrapping. A body is
// only consumable one way, so at most one of them ever takes the ref.
function trackBodyKeepalive(res: Response): Response {
	const source = p.responseBody(res);
	if (!source) return res;

	for (let i = 0; i < p.responseConsumers.length; i++) {
		const [name, original] = p.responseConsumers[i];
		if (typeof original !== "function") continue;
		nodeP.ObjectDefineProperty(res, name, {
			configurable: true,
			writable: true,
			value: function (this: Response, ...args: unknown[]) {
				keepalive.ref();
				let released = false;
				let release = () => {
					if (released) return;
					released = true;
					keepalive.unref();
				};
				let out: Promise<unknown>;
				try {
					out = p.reflectApply(original as Function, this, args);
				} catch (err) {
					release();
					throw err;
				}
				return p.promiseThen(
					out,
					(value) => {
						release();
						return value;
					},
					(err) => {
						release();
						throw err;
					}
				);
			},
		});
	}

	let wrapped: ReadableStream<Uint8Array<ArrayBuffer>> | undefined;
	nodeP.ObjectDefineProperty(res, "body", {
		configurable: true,
		enumerable: true,
		get() {
			return (wrapped ??= refedBodyStream(source));
		},
	});

	return res;
}

globalThis.fetch = new Proxy(FETCH, {
	apply(_target, _thisArg, argArray) {
		// A pending request keeps the worker alive, mirroring node holding the
		// underlying socket open across a fetch. Reffed until the response
		// resolves; the body phase then takes its own ref, see above.
		keepalive.ref();
		let unrefed = false;
		let unref = () => {
			if (unrefed) return;
			unrefed = true;
			keepalive.unref();
		};
		return p.promiseThen(
			(async () => {
				let client = await getClient();
				return await p.reflectApply(client.fetch, client, argArray);
			})(),
			(res) => {
				unref();
				return trackBodyKeepalive(res);
			},
			(err) => {
				unref();
				throw err;
			}
		);
	},
});
globalThis.WebSocket = WebSocket;

// Hidden rather than replaced — see NATIVE_XHR. `delete` on the worker global is what makes
// `typeof XMLHttpRequest === "undefined"` true, which is what browser-detection actually tests.
delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
(
	globalThis as typeof globalThis & {
		WebSocketStream?: WebSocketStreamConstructor;
	}
).WebSocketStream = WebSocketStream;
