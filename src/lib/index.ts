import { Console } from "./console";
import { DistributiveOmit } from "../util";
import type {
	NodeMessage,
	NodeMessageReply,
	NodeReply,
} from "../protocol";

let workers = 0;

export class NodeWorker {
	private worker: Worker;
	private inflight = new Map<
		string,
		[(reply: NodeReply) => void, (error: Error) => void]
	>();

	private loadPromiseResolve: () => void;
	private loadPromise: Promise<void>;
	ready: Promise<void>;
	console: Console;

	private onmessage(message: NodeReply) {
		if (message.type === "hi") {
			this.loadPromiseResolve();
			return;
		}

		if (this.inflight.has(message.reply)) {
			let [ok, error] = this.inflight.get(message.reply)!;
			if (message.type === "error") {
				error(message.error);
			} else {
				ok(message);
			}
			this.inflight.delete(message.reply);
		}
	}

	// @internal
	send<T extends NodeMessage>(
		message: DistributiveOmit<T, "reply">,
		transfer?: Transferable[]
	): Promise<NodeMessageReply<T>> {
		return new Promise((res, rej) => {
			let reply = [...Array(16)].reduce(
				(a) => a + Math.random().toString(36),
				""
			);
			this.inflight.set(reply, [
				(x) => res(x as NodeMessageReply<T>),
				(err) => rej(err),
			]);
			this.worker.postMessage({ ...message, reply }, { transfer });
		});
	}

	constructor(workerURL: string, puterToken: string, cwd: string) {
		this.worker = new Worker(workerURL, {
			name: "node-worker-" + workers++,
			type: "module",
		});

		let res: any;
		this.loadPromise = new Promise((r) => (res = r));
		this.loadPromiseResolve = res;
		let console = new Console(this);
		this.console = console;

		this.worker.onmessage = (e) => this.onmessage(e.data);

		this.ready = (async () => {
			await this!.loadPromise;

			await this.send({
				type: "init",
				puter: puterToken,
				cwd,
				console: {
					isTTY: console.isTTY,
					stdin: console.readable,
					stdout: console.writableOut,
					stderr: console.writableErr,
				}
			}, [console.readable, console.writableOut, console.writableErr]);
		})();
	}

	async setCwd(cwd: string) {
		await this.ready;
		await this.send({ type: "cwd", cwd });
	}

	async registerVirtualModule(path: string, code: string) {
		await this.ready;
		await this.send({ type: "vmodule-add", path, code });
	}
	async removeVirtualModule(path: string) {
		await this.ready;
		await this.send({ type: "vmodule-remove", path });
	}

	async require(path: string) {
		await this.ready;
		await this.send({ type: "execute", module: "cjs", target: path });
	}
	async import(path: string) {
		await this.ready;
		await this.send({ type: "execute", module: "esm", target: path });
	}

	terminate() {
		this.worker.terminate();
		this.worker = undefined!;
		this.ready = Promise.reject(new Error("Worker terminated"));
	}
}
