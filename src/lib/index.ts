import { Console } from "./console";
import { DistributiveOmit, genuid } from "../util";
import {
	NodeMessageType,
	NodeW2PMessageReply,
	NodeW2PReply,
	NodeP2WMessage,
	NodeP2WMessageReply,
	NodeP2WReply,
	NodeW2PMessage,
} from "../protocol";
import { handlePeerConnect, handlePeerServe } from "./peer";

export { Console, type TTYState } from "./console";

type OmitW2PFields<T extends object> = Omit<T, "reply" | "to">;
type W2PHandlerRet<T extends object> = Promise<[OmitW2PFields<T>, Transferable[]] | [OmitW2PFields<T>]> | [OmitW2PFields<T>, Transferable[]] | [OmitW2PFields<T>];

let workers = 0;

export class NodeWorker {
	private worker: Worker;
	private inflight = new Map<
		string,
		[(reply: NodeP2WReply) => void, (error: Error) => void]
	>();
	private handlers = new Map<string, (message: NodeW2PMessage) => W2PHandlerRet<NodeW2PReply>>();

	private loadPromise: Promise<void>;
	ready: Promise<void>;
	console: Console;

	private onmessage(message: NodeP2WReply | NodeW2PMessage) {
		if (message.to == "worker") {
			if (this.inflight.has(message.reply)) {
				let [ok, error] = this.inflight.get(message.reply)!;
				if (message.type === "error") {
					error(message.error);
				} else {
					ok(message);
				}
				this.inflight.delete(message.reply);
			}
		} else if (message.to == "page") {
			let handler = this.handlers.get(message.type);
			if (!handler)
				throw new Error("unreachable!! register handler for this");

			(async () => {
				let reply = message.reply;
				try {
					let [ret, transfer] = await handler(message);
					this.worker.postMessage({ ...ret, reply, to: "page" }, { transfer });
				} catch (err) {
					let error = err instanceof Error ? err : new Error(err as any);
					this.worker.postMessage({ type: "error", error, reply, to: "page" });
				}
			})();
		}
	}

	private on<T extends NodeMessageType<NodeW2PMessage>>(type: T, fn: (message: Extract<NodeW2PMessage, { type: T }>) => W2PHandlerRet<NodeW2PMessageReply<Extract<NodeW2PMessage, { type: T }>>>) {
		this.handlers.set(type, fn as any);
	}

	// @internal
	send<T extends NodeP2WMessage>(
		message: DistributiveOmit<T, "reply" | "to">,
		transfer?: Transferable[]
	): Promise<NodeP2WMessageReply<T>> {
		return new Promise((res, rej) => {
			let reply = genuid();
			this.inflight.set(reply, [
				(x) => res(x as NodeP2WMessageReply<T>),
				rej
			]);
			this.worker.postMessage({ ...message, reply, to: "worker" }, { transfer });
		});
	}

	constructor(workerURL: string, puterToken: string, cwd: string, options?: { keepalive?: boolean }) {
		let keepalive = !!options?.keepalive;
		this.worker = new Worker(workerURL, {
			name: "node-worker-" + workers++,
			type: "module",
		});
		this.worker.onmessage = (e) => this.onmessage(e.data);

		this.loadPromise = new Promise((r) => this.on("hi", _ => {
			r();
			return [{ type: "done" }]
		}));

		let console = new Console(this);
		this.console = console;
		this.on("tty", (msg) => {
			this.console.handleTTYState({
				isRaw: msg.isRaw,
				echo: msg.echo,
			});
			return [{ type: "done" }];
		})

		this.on("peer-client", async (msg) => {
			let [readable, writable] = await handlePeerConnect(msg.token, msg.code, msg.signaller, msg.ice);
			return [{ type: "peer-client", readable, writable }, [readable, writable]];
		})

		this.on("peer-server", async (msg) => {
			let [code, port] = await handlePeerServe(msg.token, msg.port, msg.signaller, msg.ice);
			return [{ type: "peer-server", code, port }, [port]];
		})

		this.ready = (async () => {
			await this!.loadPromise;

			await this.send({
				type: "init",
				puter: puterToken,
				cwd,
				keepalive,
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
