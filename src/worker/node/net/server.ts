import nodeEvents from "../events";
import { Socket } from "./socket";
import { hostPeerServer } from "../../peer";

type NodeNet = typeof import("node:net");
type ServerOpts = import("node:net").ServerOpts;
type AddressInfo = import("node:net").AddressInfo;
type SocketInstance = InstanceType<typeof Socket>;

let PEER_PORT = 0;

export let Server: NodeNet["Server"] = class Server extends nodeEvents.EventEmitter {
	#listening = false;
	#closing = false;
	#code?: string;
	#listenPromise?: Promise<void>;
	#sockets = new Set<SocketInstance>();

	maxConnections = Infinity;
	connections = 0;

	constructor(
		options?: ServerOpts | ((socket: SocketInstance) => void),
		connectionListener?: (socket: SocketInstance) => void
	) {
		super();

		let listener: ((socket: SocketInstance) => void) | undefined;
		if (typeof options === "function") listener = options;
		else listener = connectionListener;

		if (listener) this.on("connection", listener);
	}

	get listening() {
		return this.#listening;
	}

	address(): AddressInfo | string | null {
		if (!this.#listening || !this.#code) return null;
		return {
			address: `${this.#code}.peer.puter.com`,
			family: "IPv4",
			port: PEER_PORT,
		};
	}

	listen(...args: any[]): this {
		let listeningListener = args.find(
			(a) => typeof a === "function"
		) as (() => void) | undefined;

		if (listeningListener) this.once("listening", listeningListener);

		if (this.#listening || this.#listenPromise) {
			let err = new Error("Server is already listening") as Error & {
				code?: string;
			};
			err.code = "ERR_SERVER_ALREADY_LISTEN";
			queueMicrotask(() => this.emit("error", err));
			return this;
		}

		this.#closing = false;

		this.#listenPromise = (async () => {
			try {
				let code = await hostPeerServer((stream) => {
					let [readable, writable] = stream;

					if (this.#closing || this.connections >= this.maxConnections) {
						readable.cancel().catch(() => {});
						writable.abort().catch(() => {});
						if (!this.#closing) {
							this.emit("drop", {
								remoteAddress: this.#code
									? `${this.#code}.peer.puter.com`
									: undefined,
								remoteFamily: "IPv4",
								remotePort: PEER_PORT,
							});
						}
						return;
					}

					let socket = new Socket() as SocketInstance & {
						_acceptStreams: (
							host: string,
							port: number,
							readable: ReadableStream<Uint8Array>,
							writable: WritableStream<Uint8Array>
						) => void;
					};
					socket._acceptStreams(
						this.#code ? `${this.#code}.peer.puter.com` : "",
						PEER_PORT,
						readable,
						writable
					);
					this.#sockets.add(socket);
					this.connections++;
					socket.once("close", () => {
						this.#sockets.delete(socket);
						this.connections = Math.max(0, this.connections - 1);
						if (this.#closing && this.#sockets.size === 0 && !this.#listening) {
							this.emit("close");
						}
					});
					this.emit("connection", socket);
				});

				this.#code = code;
				this.#listening = true;
				this.emit("listening");
			} catch (_e) {
				let e = _e instanceof Error ? _e : new Error(String(_e));
				this.#listening = false;
				this.#listenPromise = undefined;
				this.emit("error", e);
			}
		})();

		return this;
	}

	close(callback?: (err?: Error) => void): this {
		if (callback) {
			if (!this.#listening && !this.#listenPromise) {
				let err = new Error("Server is not running") as Error & {
					code?: string;
				};
				err.code = "ERR_SERVER_NOT_RUNNING";
				queueMicrotask(() => callback(err));
			} else {
				this.once("close", () => callback());
			}
		}

		this.#closing = true;
		this.#listening = false;

		if (this.#sockets.size === 0) {
			queueMicrotask(() => this.emit("close"));
		}

		return this;
	}

	getConnections(cb: (error: Error | null, count: number) => void): this {
		queueMicrotask(() => cb(null, this.connections));
		return this;
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return new Promise((resolve) => {
			this.close(() => resolve());
		});
	}
} as any;
