import { getClient } from "./index";
import type { EpoxyClient, EpoxyWS, EpoxyWSChunk } from "./epoxy-wasm";

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

export let FETCH = globalThis.fetch;

// Capture the native WebSocket BEFORE the overrides at the bottom of this module
// replace globalThis.WebSocket with the epoxy-backed one. epoxy's bundled
// WebSocketStream polyfill (js/websocketstream.ts) dials the wisp relay with
// `new WebSocket(url)` off the global, so the relay transport must use the real
// browser WebSocket — routing it through our epoxy-backed override would recurse
// infinitely (establishing the wisp tunnel would itself require the wisp tunnel).
export let NATIVE_WEBSOCKET = globalThis.WebSocket;

function emit(
	target: EventTarget,
	event: Event,
	handler?: ((event: any) => void) | null
) {
	target.dispatchEvent(event);
	handler?.call(target, event);
}

function toCloseEvent(info?: WebSocketStreamClose) {
	let code = info?.closeCode ?? 1000;
	return new CloseEvent("close", {
		code,
		reason: info?.reason ?? "",
		wasClean: code !== 1006,
	});
}

function toArrayBuffer(data: Uint8Array) {
	let buffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(buffer).set(data);
	return buffer;
}

function toMessageData(data: Uint8Array, binaryType: BinaryType) {
	if (binaryType === "arraybuffer") {
		return toArrayBuffer(data);
	}
	return new Blob([toArrayBuffer(data)]);
}

function normalizeProtocols(protocols?: string | string[]) {
	if (!protocols) return undefined;
	return Array.isArray(protocols) ? protocols : [protocols];
}

function toWritableChunk(
	data: string | ArrayBufferLike | Blob | ArrayBufferView
) {
	if (typeof data === "string") return Promise.resolve(data);
	if (data instanceof Blob)
		return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
	if (ArrayBuffer.isView(data)) {
		return Promise.resolve(
			new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		);
	}
	return Promise.resolve(new Uint8Array(data));
}

function chunkSize(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
	if (typeof data === "string")
		return new TextEncoder().encode(data).byteLength;
	if (data instanceof Blob) return data.size;
	if (ArrayBuffer.isView(data)) return data.byteLength;
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
		this.url = String(url);
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
			let socket = await getClient().then((client) =>
				client.websocket(this.url, {
					protocols: normalizeProtocols(protocols),
				})
			);
			if (this.readyState !== EpoxyBackedWebSocket.CONNECTING) {
				socket.close();
				return;
			}

			this.#socket = socket;
			this.#writer = socket.writable.getWriter();
			this.protocol = socket.protocol;
			this.extensions = socket.headers.get("sec-websocket-extensions") ?? "";
			this.readyState = EpoxyBackedWebSocket.OPEN;
			emit(this, new Event("open"), this.onopen);

			void this.#pump(socket);
		} catch (_err) {
			this.#fail();
		}
	}

	async #pump(socket: EpoxyWS) {
		try {
			let reader = socket.readable.getReader();
			while (true) {
				let { done, value } = await reader.read();
				if (
					done ||
					value === undefined ||
					this.readyState !== EpoxyBackedWebSocket.OPEN
				) {
					break;
				}
				emit(
					this,
					new MessageEvent("message", {
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
			throw new DOMException("WebSocket is not open", "InvalidStateError");
		}

		let size = chunkSize(data);
		this.bufferedAmount += size;
		void (async () => {
			try {
				await this.#writer!.write(await toWritableChunk(data));
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
		emit(this, new Event("error"), this.onerror);
		this.#finalize({ closeCode: 1006 });
	}

	#finalize(closeInfo?: WebSocketStreamClose) {
		if (this.readyState === EpoxyBackedWebSocket.CLOSED) return;
		this.readyState = EpoxyBackedWebSocket.CLOSED;
		this.#writer?.releaseLock();
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
		let _url = String(url);
		this.url = _url;
		this.closed = new Promise((resolve, reject) => {
			this.#closedResolve = resolve;
			this.#closedReject = reject;
		});

		this.opened = (async () => {
			if (options?.signal?.aborted) {
				let err = new DOMException("WebSocketStream aborted", "AbortError");
				this.#rejectClosed(err);
				throw err;
			}

			if (options?.signal) {
				options.signal.addEventListener(
					"abort",
					() => {
						let err = new DOMException("WebSocketStream aborted", "AbortError");
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

			let socket = await getClient().then((client) =>
				client.websocket(_url, {
					protocols: normalizeProtocols(options?.protocols),
					headers: options?.headers,
				})
			);
			if (this.#closedEarly) {
				socket.close(this.#closedInfo);
				throw new DOMException("WebSocketStream is closed", "InvalidStateError");
			}
			if (this.#abortError) {
				socket.close();
				throw this.#abortError;
			}
			this.#socket = socket;
			void socket.closed.then(
				(value) => this.#resolveClosed(value),
				(err) => this.#rejectClosed(err)
			);

			return {
				extensions: socket.headers.get("sec-websocket-extensions") ?? "",
				protocol: socket.protocol,
				readable: socket.readable,
				writable: socket.writable,
			};
		})();

		void this.opened.catch((err) => {
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

globalThis.fetch = new Proxy(FETCH, {
	apply(target, thisArg, argArray) {
		return (async () => {
			let client = await getClient();
			return Reflect.apply(client.fetch, client, argArray);
		})();
	},
});
globalThis.WebSocket = WebSocket;
(
	globalThis as typeof globalThis & {
		WebSocketStream?: WebSocketStreamConstructor;
	}
).WebSocketStream = WebSocketStream;
