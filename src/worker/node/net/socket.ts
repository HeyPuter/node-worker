import nodeStream from "../stream";
import nodeBuffer from "../buffer";
import { getClient } from "../../epoxy";
let Buffer = nodeBuffer.Buffer;

type NodeNet = typeof import("node:net");
type SocketOpts = import("node:net").SocketConstructorOpts;

type ConnectOptions = import("node:net").SocketConnectOpts;
type TcpConnectOptions = import("node:net").TcpSocketConnectOpts;
type IpcConnectOptions = import("node:net").IpcSocketConnectOpts;

export let Socket: NodeNet["Socket"] = class Socket extends nodeStream.Duplex {
	#read: (buf: Uint8Array) => void;
	#reader?: ReadableStreamDefaultReader<Uint8Array>;
	#writer?: WritableStreamDefaultWriter<Uint8Array>;
	#connectPromise?: Promise<void>;
	#bytesRead = 0;
	#bytesWritten = 0;
	#host?: string;
	#port?: number;
	#connecting = false;
	#pending = true;
	#bufferSize = 0;

	constructor(options?: SocketOpts) {
		super({ allowHalfOpen: options?.allowHalfOpen ?? false });
		if (!options) options = {};

		// options.readable and options.writable ignored
		if (options.fd) throw new Error("unsupported");
		if (options.blockList) throw new Error("unsupported");

		if (options.signal) {
			if (options.signal.aborted) {
				queueMicrotask(() => {
					this.destroy(new Error("Socket operation was aborted"));
				});
			} else {
				options.signal.addEventListener(
					"abort",
					() => {
						this.destroy(new Error("Socket operation was aborted"));
					},
					{ once: true }
				);
			}
		}

		if (options.onread) {
			let _target: Buffer | Uint8Array;
			if (typeof options.onread.buffer == "function") {
				_target = options.onread.buffer();
			} else {
				_target = options.onread.buffer;
			}
			let target = new Uint8Array(
				_target.buffer,
				_target.byteOffset,
				_target.byteLength
			);
			let cb = options.onread.callback;
			if (!target.byteLength) throw new Error("onread buffer cannot be empty");

			this.#read = (buf) => {
				while (buf.byteLength) {
					let split = buf.subarray(0, target.byteLength);
					buf = buf.subarray(target.byteLength);
					target.set(split);
					let shouldContinue = cb(split.byteLength, target);
					if (shouldContinue === false) this.pause();
				}
			};
		} else {
			this.#read = (buf) => {
				this.push(Buffer.from(buf));
			};
		}
	}

	_acceptStreams(
		host: string,
		port: number,
		readable: ReadableStream<Uint8Array>,
		writable: WritableStream<Uint8Array>
	) {
		this.#host = host;
		this.#port = port;
		this.#reader = readable.getReader();
		this.#writer = writable.getWriter();
		this.#connecting = false;
		this.#pending = false;

		queueMicrotask(() => {
			this.emit("connect");
			this.emit("ready");
		});

		void this.#pumpRead();
	}

	async #pumpRead() {
		if (!this.#reader) return;

		try {
			while (true) {
				let { done, value } = await this.#reader.read();
				if (done) break;
				if (!value) continue;

				this.#bytesRead += value.byteLength;
				this.#read(value);
			}

			this.push(null);
		} catch (_e) {
			let e = _e instanceof Error ? _e : new Error(String(_e));
			this.destroy(e);
		}
	}

	_read() {}

	_write(
		chunk: Uint8Array | string,
		encoding: BufferEncoding,
		callback: (error?: Error | null) => void
	) {
		(async () => {
			if (this.#connectPromise) await this.#connectPromise;
			if (!this.#writer) throw new Error("Socket is not connected");

			let buffer =
				typeof chunk === "string"
					? Buffer.from(chunk, encoding)
					: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			let writeSize = buffer.byteLength;
			this.#bufferSize += writeSize;

			let writer = this.#writer;
			let writePromise = writer.write(buffer);
			writePromise
				.then(() => writer.ready)
				.then(
					() => {
						this.#bufferSize = Math.max(0, this.#bufferSize - writeSize);
					},
					() => {
						this.#bufferSize = Math.max(0, this.#bufferSize - writeSize);
					}
				);

			await writePromise;

			this.#bytesWritten += buffer.byteLength;
		})()
			.then(() => callback())
			.catch((_e) => {
				let e = _e instanceof Error ? _e : new Error(String(_e));
				callback(e);
			});
	}

	_final(callback: (error?: Error | null) => void) {
		if (!this.#writer) {
			callback();
			return;
		}

		this.#writer
			.close()
			.then(() => {
				this.#writer = undefined;
				callback();
			})
			.catch((_e) => {
				let e = _e instanceof Error ? _e : new Error(String(_e));
				callback(e);
			});
	}

	_destroy(
		error: Error | null,
		callback: (error?: Error | null | undefined) => void
	) {
		this.#connecting = false;
		this.#pending = false;
		this.#bufferSize = 0;

		let reader = this.#reader;
		let writer = this.#writer;
		this.#reader = undefined;
		this.#writer = undefined;

		Promise.allSettled([
			reader ? reader.cancel(error ?? undefined) : Promise.resolve(),
			writer ? writer.abort(error ?? undefined) : Promise.resolve(),
		])
			.then(() => callback(error))
			.catch(() => callback(error));
	}

	get autoSelectFamilyAttemptedAddresses(): string[] {
		throw new Error("unsupported");
	}

	get bytesRead() {
		return this.#bytesRead;
	}

	get bytesWritten() {
		return this.#bytesWritten;
	}

	get bufferSize() {
		return this.#bufferSize;
	}

	get connecting() {
		return this.#connecting;
	}

	get pending() {
		return this.#pending;
	}

	get remoteAddress() {
		return this.#host;
	}

	get remotePort() {
		return this.#port;
	}

	get remoteFamily() {
		if (!this.#host) return undefined;
		return this.#host.includes(":") ? "IPv6" : "IPv4";
	}

	get readyState(): import("node:net").SocketReadyState {
		if (this.destroyed) return "closed";
		if (this.#connecting) return "opening";
		if (this.readableEnded && !this.writableEnded) return "writeOnly";
		if (!this.readableEnded && this.writableEnded) return "readOnly";
		return "open";
	}

	address() {
		return {};
	}

	destroySoon() {
		if (this.writableFinished) {
			this.destroy();
			return;
		}

		this.end(() => this.destroy());
	}

	resetAndDestroy() {
		this.destroy();
		return this;
	}

	setTimeout(timeout: number, callback?: () => void) {
		void timeout;
		void callback;
		return this;
	}

	setNoDelay() {
		return this;
	}

	setKeepAlive() {
		return this;
	}

	ref() {
		return this;
	}

	unref() {
		return this;
	}

	connect(
		options:
			| ConnectOptions
			| TcpConnectOptions["port"]
			| IpcConnectOptions["path"],
		arg1?: NonNullable<TcpConnectOptions["host"]> | (() => void),
		connectionListener?: () => void
	): this {
		let host: string;
		let port: number;
		let onConnect: (() => void) | undefined;
		let bufferSize: number | undefined;

		if (typeof options == "object" && options !== null) {
			onConnect = typeof arg1 == "function" ? arg1 : connectionListener;
			if (!("port" in options)) throw new Error("unsupported");

			host = options.host ?? "localhost";
			port = options.port;
		} else if (typeof options == "string") {
			onConnect = typeof arg1 == "function" ? arg1 : connectionListener;
			throw new Error("unsupported");
		} else {
			host = typeof arg1 == "string" ? arg1 : "localhost";
			port = options;
			onConnect = typeof arg1 == "function" ? arg1 : connectionListener;
		}

		if (!Number.isInteger(port) || port < 0 || port > 65535) {
			throw new RangeError("port must be an integer between 0 and 65535");
		}
		if (onConnect) this.once("connect", onConnect);

		this.#host = host;
		this.#port = port;
		this.#connecting = true;
		this.#pending = true;

		this.#connectPromise = (async () => {
			let client = await getClient();
			let stream = await client.connect(host, port, bufferSize);
			this.#reader = stream.read.getReader();
			this.#writer = stream.write.getWriter();

			this.#connecting = false;
			this.#pending = false;
			this.emit("connect");
			this.emit("ready");

			void this.#pumpRead();
		})();

		this.#connectPromise.catch((_e) => {
			let e = _e instanceof Error ? _e : new Error(String(_e));
			this.destroy(e);
		});

		return this;
	}
};
