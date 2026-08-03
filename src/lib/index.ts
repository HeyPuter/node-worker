import { Console } from "./console";
import { DistributiveOmit, genuid } from "../util";
import {
	NodeMessageType,
	NodeW2PMessageReply,
	NodeW2PReply,
	NodeExecuteMessage,
	NodeMemListEntry,
	NodeMemListMessage,
	NodeMemReadMessage,
	NodeMemWriteMessage,
	NodeP2WMessage,
	NodeP2WMessageReply,
	NodeP2WReply,
	NodeW2PMessage,
} from "../protocol";
import { handlePeerConnect, handlePeerServe } from "./peer";
import { handleFsEvents } from "./fsevents";

export { Console, type TTYState } from "./console";
export type { NodeMemListEntry } from "../protocol";

/**
 * The worker called `process.exit`, so it has been terminated.
 *
 * Every promise in flight at that moment rejects with this, including the `execute`
 * that was running — a dead worker cannot answer, and leaving those pending would
 * hang the caller forever. `code` is the program's exit status, so a caller driving
 * a CLI can report it rather than treat the rejection as a failure.
 */
export class WorkerExitError extends Error {
	constructor(readonly code: number) {
		super(`worker exited with code ${code}`);
		this.name = "WorkerExitError";
	}
}

/** Options shared by `import` and `require`: what the run's process looks like. */
export interface RunOptions {
	/** Complete `process.argv`, `argv[0]` included. Defaults to `["node", path]`. */
	argv?: string[];
	/** Replaces `process.env` wholesale, `TERM` included. */
	env?: Record<string, string>;
}

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
	private exitListeners = new Set<(code: number) => void | Promise<void>>();
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
					this.post({ ...ret, reply, to: "page" }, transfer);
				} catch (err) {
					let error = err instanceof Error ? err : new Error(err as any);
					this.post({ type: "error", error, reply, to: "page" });
				}
			})();
		}
	}

	private on<T extends NodeMessageType<NodeW2PMessage>>(type: T, fn: (message: Extract<NodeW2PMessage, { type: T }>) => W2PHandlerRet<NodeW2PMessageReply<Extract<NodeW2PMessage, { type: T }>>>) {
		this.handlers.set(type, fn as any);
	}

	/**
	 * Post to the worker if it is still there.
	 *
	 * A W2P handler is allowed to terminate the worker — the `exit` one does exactly
	 * that — so by the time its reply is ready there may be nothing to reply to. The
	 * worker sent that message fire-and-forget for precisely this reason, so dropping
	 * the reply is correct; throwing on a detached `worker` would only turn it into an
	 * unhandled rejection.
	 */
	private post(message: object, transfer?: Transferable[]) {
		this.worker?.postMessage(message, { transfer });
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

		// The worker is the process, so `process.exit` is the process dying and the
		// worker goes with it. Listeners are awaited *before* the terminate: a
		// consumer whose state lives inside the worker — a memory mount it treats as
		// a replica, say — gets its one chance to read it out here, and there is no
		// second one.
		this.on("exit", async (msg) => {
			for (let listener of [...this.exitListeners]) {
				try {
					await listener(msg.code);
				} catch (err) {
					// `globalThis`-qualified: the constructor shadows `console` with the
					// worker's stdio Console, which has no `error`.
					globalThis.console.error("[node-worker] exit listener failed", err);
				}
			}
			this.terminate(new WorkerExitError(msg.code));
			return [{ type: "done" }];
		});

		this.on("peer-client", async (msg) => {
			let [readable, writable] = await handlePeerConnect(msg.token, msg.code, msg.signaller, msg.ice);
			return [{ type: "peer-client", readable, writable }, [readable, writable]];
		})

		this.on("peer-server", async (msg) => {
			let [code, port] = await handlePeerServe(msg.token, msg.port, msg.signaller, msg.ice);
			return [{ type: "peer-server", code, port }, [port]];
		})

		// Backs node:fs's watchers. The socket lives here rather than in the
		// worker so it's a plain browser WebSocket (the worker's global is
		// epoxy's WISP-tunnelled override) and so one connection serves every
		// watcher across every worker on the token.
		this.on("fs-events", (msg) => {
			let port = handleFsEvents(msg.token, msg.apiOrigin);
			return [{ type: "fs-events", port }, [port]];
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

	// ------------------------------------------------- in-memory filesystems
	//
	// Mount a directory backed by memory and fill it from here. The runtime sees
	// ordinary files — they stat, list, resolve and execute like anything in real
	// storage — but nothing is uploaded and nothing survives the worker.
	//
	//   await worker.mountMemory("/proj");
	//   await worker.writeMemory("/proj", [
	//     { path: "package.json", data: enc.encode(pkgJson) },
	//     { path: "src/main.js",  data: enc.encode(src) },
	//     { path: "public/logo.png", data: pngBytes },
	//   ]);
	//   await worker.setCwd("/proj");
	//   await worker.import("/proj/src/main.js");

	/**
	 * Create a memory-backed directory at `root`.
	 *
	 * `replace` swaps out an existing mount at the same root instead of throwing,
	 * which is what re-populating a project between runs wants.
	 */
	async mountMemory(
		root: string,
		options?: { readOnly?: boolean; replace?: boolean }
	) {
		await this.ready;
		await this.send({
			type: "mem-mount",
			root,
			readOnly: options?.readOnly,
			replace: options?.replace,
		});
	}

	async unmountMemory(root: string) {
		await this.ready;
		await this.send({ type: "mem-unmount", root });
	}

	/**
	 * Write entries into the memory mount at `root`, or into the overlay over the
	 * real filesystem when `root` is "/".
	 *
	 * Entry paths are relative to the mount root, and files create their own parent
	 * directories — an entry with no `data` is only needed for a deliberately empty
	 * one. Strings are encoded as UTF-8.
	 *
	 * Pass `transfer: true` to hand the underlying buffers to the worker instead of
	 * copying them, which matters when populating something the size of a real
	 * dependency tree. It **detaches** them: every `Uint8Array` and `ArrayBuffer`
	 * you passed is unusable afterwards, so only do it with buffers you own.
	 */
	async writeMemory(
		root: string,
		files: Array<{
			path: string;
			data?: string | Uint8Array | ArrayBuffer;
			mtimeMs?: number;
		}>,
		options?: { transfer?: boolean }
	): Promise<{ written: number; bytes: number }> {
		await this.ready;

		let encoder = new TextEncoder();
		let entries = files.map((f) => {
			let data: Uint8Array | undefined;
			if (f.data === undefined) data = undefined;
			else if (typeof f.data === "string") data = encoder.encode(f.data);
			else if (f.data instanceof ArrayBuffer) data = new Uint8Array(f.data);
			else data = f.data;
			return { path: f.path, data, mtimeMs: f.mtimeMs };
		});

		let transfer: Transferable[] | undefined;
		if (options?.transfer) {
			// Deduped: several entries may be views onto one buffer, and listing a
			// buffer twice in a transfer list throws.
			let seen = new Set<ArrayBufferLike>();
			for (let e of entries) {
				if (e.data && !seen.has(e.data.buffer)) {
					seen.add(e.data.buffer);
				}
			}
			transfer = [...seen] as Transferable[];
		}

		// Explicit type argument: `send`'s parameter is a `DistributiveOmit<T, …>`,
		// which is not an inference site, so `T` would otherwise widen to the whole
		// message union and the reply with it. Every other call ignores its reply, so
		// this is the first place it shows.
		let reply = await this.send<NodeMemWriteMessage>(
			{ type: "mem-write", root, entries },
			transfer
		);
		return { written: reply.written, bytes: reply.bytes };
	}

	/** Remove paths (relative to `root`) from a memory mount. */
	async removeMemory(root: string, paths: string[]) {
		await this.ready;
		await this.send({ type: "mem-remove", root, paths });
	}

	/**
	 * Read one file out of a memory mount, or `undefined` if the path is absent or a
	 * directory. `path` is relative to `root`.
	 *
	 * The counterpart to `writeMemory`, and what lets the host treat a mount as a
	 * replica of state it owns rather than as the only copy: whatever the runtime
	 * wrote in there can be pulled back out and survive the worker.
	 */
	async readMemory(root: string, path: string): Promise<Uint8Array | undefined> {
		await this.ready;
		let reply = await this.send<NodeMemReadMessage>({
			type: "mem-read",
			root,
			path,
		});
		return reply.data;
	}

	/**
	 * List a directory in a memory mount, or `undefined` if the path is absent or a
	 * file. `path` is relative to `root`; `""` and `"/"` both mean the root itself.
	 *
	 * `since` reports only what was modified after that time, which is what makes
	 * "what did this run touch?" one cheap message even when the mount holds a
	 * `node_modules`. The walk is complete regardless — a directory's mtime says
	 * nothing about its descendants — so the saving is in the reply, not the search.
	 */
	async listMemory(
		root: string,
		path: string,
		options?: { recursive?: boolean; since?: number }
	): Promise<NodeMemListEntry[] | undefined> {
		await this.ready;
		let reply = await this.send<NodeMemListMessage>({
			type: "mem-list",
			root,
			path,
			recursive: options?.recursive,
			since: options?.since,
		});
		return reply.entries;
	}

	/**
	 * Run `path` as CommonJS and resolve with its exit code.
	 *
	 * Rejects with `WorkerExitError` if the program called `process.exit`, which also
	 * terminates the worker — read `err.code` for the status.
	 */
	async require(path: string, options?: RunOptions): Promise<number> {
		return this.execute("cjs", path, options);
	}

	/** As `require`, but run `path` as an ES module. */
	async import(path: string, options?: RunOptions): Promise<number> {
		return this.execute("esm", path, options);
	}

	private async execute(
		module: "cjs" | "esm",
		target: string,
		options?: RunOptions
	): Promise<number> {
		await this.ready;
		let reply = await this.send<NodeExecuteMessage>({
			type: "execute",
			module,
			target,
			argv: options?.argv,
			env: options?.env,
		});
		return reply.exitCode;
	}

	/**
	 * Called when the worker exits of its own accord, before it is terminated.
	 *
	 * A listener returning a promise is awaited, which is the only window in which
	 * worker-side state can still be read. Returns an unsubscribe function.
	 */
	onExit(listener: (code: number) => void | Promise<void>): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	/**
	 * Stop the worker. Idempotent.
	 *
	 * Every request still in flight is rejected with `reason`, because a terminated
	 * worker will never answer one. That matters most for the `execute` of a program
	 * that just called `process.exit`: without this it would stay pending forever, and
	 * the caller would be left waiting on a run that has already finished.
	 */
	terminate(reason?: Error) {
		if (!this.worker) return;
		this.worker.terminate();
		this.worker = undefined!;

		let error = reason ?? new Error("Worker terminated");
		let pending = [...this.inflight.values()];
		this.inflight.clear();
		for (let [, reject] of pending) reject(error);

		this.ready = Promise.reject(error);
		// Nothing necessarily awaits the replacement `ready`, and an unobserved
		// rejected promise is a console warning in every browser.
		this.ready.catch(() => {});
	}
}
