import { NodeWorker } from ".";

export interface TTYState {
	isRaw: boolean;
	echo: boolean;
}

// TODO add backpressure across the worker?
export class Console {
	// @internal
	// stdout's other side
	readonly writableOut: WritableStream<Uint8Array<ArrayBuffer>>;
	readonly writableErr: WritableStream<Uint8Array<ArrayBuffer>>;
	// @internal
	// stdin's other side
	readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;

	private worker: NodeWorker;
	private consoleIsTty = true;
	private ttyStateValue: TTYState = {
		isRaw: false,
		echo: true,
	};
	private ttyListeners = new Set<(state: TTYState) => void>();

	readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>>;
	readonly stderr: ReadableStream<Uint8Array<ArrayBuffer>>;
	readonly stdin: WritableStream<Uint8Array<ArrayBuffer>>;

	constructor(worker: NodeWorker) {
		let { readable: out1, writable: out2 } = new TransformStream();
		this.stdout = out1;
		this.writableOut = out2;

		let { readable: err1, writable: err2 } = new TransformStream();
		this.stderr = err1;
		this.writableErr = err2;

		let { readable: in2, writable: in1 } = new TransformStream();
		this.stdin = in1;
		this.readable = in2;

		this.worker = worker;
	}

	// ------------------------------------------------------------------- stdio
	//
	// The worker's end of these used to be the streams themselves, transferred at startup.
	// It is messages now, which is what lets `readSync(0)` and `writeSync(1)` work at all —
	// a stream can only be read asynchronously, and stdio that cannot be synchronous is
	// stdio node programs cannot use. The embedder's view is unchanged: it still writes
	// `stdin` and reads `stdout`/`stderr`.

	#outWriter: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | undefined;
	#errWriter: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | undefined;
	#inReader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
	/** Bytes read from stdin but not yet asked for. */
	#leftover: Uint8Array<ArrayBuffer> | undefined;
	#stdinEnded = false;
	/** The tail of the write chain, so `flush` can wait for what is already queued. */
	#writes: Promise<unknown> = Promise.resolve();

	/** @internal */
	writeStdio(fd: 1 | 2, bytes: Uint8Array<ArrayBuffer>): void {
		const writer =
			fd === 2
				? (this.#errWriter ??= this.writableErr.getWriter())
				: (this.#outWriter ??= this.writableOut.getWriter());
		// Chained rather than awaited: a write must not block the message that carried it,
		// and the chain is what keeps the bytes in order anyway.
		this.#writes = this.#writes.then(
			() => writer.write(bytes),
			() => writer.write(bytes)
		);
	}

	/** @internal */
	async flushStdio(): Promise<void> {
		await this.#writes.catch(() => {});
	}

	/**
	 * @internal
	 *
	 * `blocking` is the difference between a prompt and a poll. A blocking read waits for
	 * input or for the stream to end; a non-blocking one answers with whatever is already
	 * here, which may be nothing at all.
	 */
	async readStdio(
		length: number,
		blocking: boolean
	): Promise<{ bytes: Uint8Array<ArrayBuffer>; eof: boolean }> {
		const empty = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
		if (!this.#leftover?.length) {
			if (this.#stdinEnded) return { bytes: empty, eof: true };
			if (!blocking) return { bytes: empty, eof: false };
			const reader = (this.#inReader ??= this.readable.getReader());
			const { value, done } = await reader.read();
			if (done) {
				this.#stdinEnded = true;
				return { bytes: empty, eof: true };
			}
			this.#leftover = value;
		}
		const held = this.#leftover!;
		if (held.length <= length) {
			this.#leftover = undefined;
			return { bytes: held, eof: false };
		}
		this.#leftover = held.subarray(length) as Uint8Array<ArrayBuffer>;
		return {
			bytes: held.subarray(0, length) as Uint8Array<ArrayBuffer>,
			eof: false,
		};
	}

	get isTTY() {
		return this.consoleIsTty;
	}
	get ttyState() {
		return this.ttyStateValue;
	}
	onTTYChange(listener: (state: TTYState) => void) {
		this.ttyListeners.add(listener);
		listener(this.ttyStateValue);
		return () => {
			this.ttyListeners.delete(listener);
		};
	}
	handleTTYState(state: Partial<TTYState>) {
		this.ttyStateValue = {
			...this.ttyStateValue,
			...state,
		};

		for (let listener of this.ttyListeners) {
			listener(this.ttyStateValue);
		}
	}
	async setIsTTY(value: boolean, size?: { columns?: number; rows?: number }) {
		await this.worker.control({
			op: "ctl.setTty",
			isTTY: value,
			size,
		});
		this.consoleIsTty = value;
	}

	/**
	 * Report the terminal's dimensions as `process.stdout.columns`/`rows`.
	 *
	 * Call it again when the terminal is resized: a CLI that lays out a progress line
	 * reads these on every write, so a stale width shows up as wrapped or truncated
	 * output rather than as an error.
	 */
	async setSize(size: { columns?: number; rows?: number }) {
		await this.worker.control({
			op: "ctl.setTty",
			isTTY: this.consoleIsTty,
			size,
		});
	}
}
