import { NodeWorker } from ".";

export interface TTYState {
	isTTY: boolean;
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
		isTTY: true,
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
		if (state.isTTY !== undefined) {
			this.consoleIsTty = state.isTTY;
		}

		this.ttyStateValue = {
			...this.ttyStateValue,
			...state,
		};

		for (let listener of this.ttyListeners) {
			listener(this.ttyStateValue);
		}
	}
	async setIsTTY(value: boolean) {
		await this.worker.send({ type: "set-tty", isTTY: value });
		this.consoleIsTty = value;
		this.handleTTYState({ isTTY: value });
	}
}
