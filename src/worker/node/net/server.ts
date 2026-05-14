// @ts-nocheck
import nodeEvents from "../events";
import { Socket } from "./socket";
import { hostPeerServer } from "../../peer";
import * as keepalive from "../../keepalive";

type NodeNet = typeof import("node:net");
type ServerOpts = import("node:net").ServerOpts;
type AddressInfo = import("node:net").AddressInfo;
type SocketInstance = InstanceType<typeof Socket>;

let PEER_PORT = 0;

const kListening = Symbol("listening");
const kClosing = Symbol("closing");
const kCode = Symbol("code");
const kListenPromise = Symbol("listenPromise");
const kSockets = Symbol("sockets");
const kRefed = Symbol("refed");
const kCounted = Symbol("counted");

type ServerState = {
	[kListening]: boolean;
	[kClosing]: boolean;
	[kCode]?: string;
	[kListenPromise]?: Promise<void>;
	[kSockets]: Set<SocketInstance>;
	maxConnections: number;
	connections: number;
};

type ServerListener = (socket: SocketInstance) => void;

function Server(this: any, options?: ServerOpts | ServerListener, connectionListener?: ServerListener) {
	if (!(this instanceof Server)) {
		return new (Server as any)(options, connectionListener);
	}

	(nodeEvents.EventEmitter as any).call(this);
	this[kListening] = false;
	this[kClosing] = false;
	this[kCode] = undefined;
	this[kListenPromise] = undefined;
	this[kSockets] = new Set();
	this[kRefed] = true;
	this[kCounted] = false;
	this.maxConnections = Infinity;
	this.connections = 0;

	let listener: ServerListener | undefined;
	if (typeof options === "function") listener = options;
	else listener = connectionListener;

	if (listener) this.on("connection", listener);
}

Object.setPrototypeOf(Server.prototype, nodeEvents.EventEmitter.prototype);
Object.setPrototypeOf(Server, nodeEvents.EventEmitter);

Object.defineProperty(Server.prototype, "listening", {
	configurable: true,
	enumerable: true,
	get() {
		return this[kListening];
	},
});

Server.prototype.address = function address(this: any): AddressInfo | string | null {
	if (!this[kListening] || !this[kCode]) return null;
	return {
		address: `${this[kCode]}.peer.puter.com`,
		family: "IPv4",
		port: PEER_PORT,
	};
};

Server.prototype.listen = function listen(this: any, ...args: any[]): ServerState {
	let listeningListener = args.find(
		(a) => typeof a === "function"
	) as (() => void) | undefined;

	if (listeningListener) this.once("listening", listeningListener);

	if (this[kListening] || this[kListenPromise]) {
		let err = new Error("Server is already listening") as Error & {
			code?: string;
		};
		err.code = "ERR_SERVER_ALREADY_LISTEN";
		queueMicrotask(() => this.emit("error", err));
		return this;
	}

	this[kClosing] = false;

	this[kListenPromise] = (async () => {
		try {
			let code = await hostPeerServer((stream) => {
				let [readable, writable] = stream;

				if (this[kClosing] || this.connections >= this.maxConnections) {
					readable.cancel().catch(() => {});
					writable.abort().catch(() => {});
					if (!this[kClosing]) {
						this.emit("drop", {
							remoteAddress: this[kCode]
								? `${this[kCode]}.peer.puter.com`
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
					this[kCode] ? `${this[kCode]}.peer.puter.com` : "",
					PEER_PORT,
					readable,
					writable
				);
				this[kSockets].add(socket);
				this.connections++;
				socket.once("close", () => {
					this[kSockets].delete(socket);
					this.connections = Math.max(0, this.connections - 1);
					if (this[kClosing] && this[kSockets].size === 0 && !this[kListening]) {
						this.emit("close");
					}
				});
				this.emit("connection", socket);
			});

			this[kCode] = code;
			this[kListening] = true;
			if (this[kRefed] && !this[kCounted]) {
				this[kCounted] = true;
				keepalive.ref();
			}
			this.emit("listening");
		} catch (_e) {
			let e = _e instanceof Error ? _e : new Error(String(_e));
			this[kListening] = false;
			this[kListenPromise] = undefined;
			this.emit("error", e);
		}
	})();

	return this;
};

Server.prototype.close = function close(this: any, callback?: (err?: Error) => void): ServerState {
	if (callback) {
		if (!this[kListening] && !this[kListenPromise]) {
			let err = new Error("Server is not running") as Error & {
				code?: string;
			};
			err.code = "ERR_SERVER_NOT_RUNNING";
			queueMicrotask(() => callback(err));
		} else {
			this.once("close", () => callback());
		}
	}

	this[kClosing] = true;
	this[kListening] = false;
	if (this[kCounted]) {
		this[kCounted] = false;
		keepalive.unref();
	}

	if (this[kSockets].size === 0) {
		queueMicrotask(() => this.emit("close"));
	}

	return this;
};

Server.prototype.getConnections = function getConnections(this: any, cb: (error: Error | null, count: number) => void): ServerState {
	queueMicrotask(() => cb(null, this.connections));
	return this;
};

Server.prototype.ref = function ref(this: any): ServerState {
	this[kRefed] = true;
	if (this[kListening] && !this[kCounted]) {
		this[kCounted] = true;
		keepalive.ref();
	}
	return this;
};

Server.prototype.unref = function unref(this: any): ServerState {
	this[kRefed] = false;
	if (this[kCounted]) {
		this[kCounted] = false;
		keepalive.unref();
	}
	return this;
};

Server.prototype[Symbol.asyncDispose] = function asyncDispose(this: any): Promise<void> {
	return new Promise((resolve) => {
		this.close(() => resolve());
	});
};

export { Server };
export default Server as unknown as NodeNet["Server"];
