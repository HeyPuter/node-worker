import { Console } from "./console";
import { DistributiveOmit, genuid } from "../util";
import {
	NodeMessageType,
	NodeW2PMessageReply,
	NodeW2PReply,
	NodeExecuteMessage,
	NodeP2WMessage,
	NodeP2WMessageReply,
	NodeP2WReply,
	NodeW2PMessage,
	NodeInitMessage,
	NodeNetInit,
} from "../protocol";
import { handlePeerConnect, handlePeerServe } from "./peer";
import { broadcastLocalFsEvent, handleFsEvents } from "./fsevents";
import { fromWireError, toWireError } from "../vfs/errno";
import { NODEFS_PROTO, type NodeFsCapabilities } from "../vfs/wire";
import { SYNC_TIMEOUT_MS } from "../vfs/sw-wire";
import { NodeVfs, randomSid, type MemListEntry } from "./vfs/index";
import { attachSession, SyncFsUnavailable, type Attachment } from "./sw";

export { Console, type TTYState } from "./console";
// `MemListEntry` (from ./vfs) replaces the old `NodeMemListEntry` wire type.
export type { MemListEntry as NodeMemListEntry } from "./vfs/index";

// The filesystem, and everything needed to extend it.
//
// `NodeVfs` is the host-side namespace a worker runs on; a consumer mounts providers on it,
// populates memory mounts and reads them back, all synchronously. `VfsProvider` is the
// extension point — implement it with ordinary async code (OPFS, the File System Access api,
// IndexedDB, a fetch) and mount it.
export {
	NodeVfs,
	createMemoryProvider,
	createPuterProvider,
	createDirectoryHandleProvider,
	ensureDirectoryHandleAccess,
	unionProvider,
	createCachingProvider,
	type CachingProvider,
	type VfsCacheOptions,
	type VfsCacheFreshness,
	type NodeVfsOptions,
	type MemEntry,
	type MemoryMount,
	type MemListEntry,
	type MemListOptions,
	type WriteTarget,
	type DirectoryHandleProviderOptions,
	type MountContext,
	type FsEvents,
} from "./vfs/index";
export type { VfsProvider, ProviderStream } from "../vfs/provider";
export type { FsEntry, Listing, ReaddirOpts, WireCtx } from "../vfs/entry";
export type { MountSnapshot, NodeFsCapabilities } from "../vfs/wire";
export { fsError, VfsError, type WireError } from "../vfs/errno";
export { SyncFsUnavailable } from "./sw";
export type { NodeNetInit } from "../protocol";

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

export interface NodeWorkerOptions {
	keepalive?: boolean;
	/**
	 * `dist/sw.js`, however your bundler spells its URL. Required for synchronous `fs`.
	 *
	 * It must sit where its default registration scope covers `workerURL` — which
	 * `import swURL from "node-worker/sw?url"` gives you for free, since bundlers emit it
	 * beside the worker. Measured across Blink, Gecko and WebKit: the worker being in scope
	 * is what decides interception, and the *page* needs no control at all, so no
	 * `Service-Worker-Allowed` header is involved.
	 */
	swURL?: string;
	/** Registration scope. Defaults to the directory `swURL` sits in. */
	swScope?: string;
	/**
	 * The filesystem this worker runs on. A fresh one per worker by default, because every
	 * worker has always had its own `/tmp`, its own overlay and its own memory mounts — pass
	 * an instance to share a namespace between workers deliberately.
	 */
	vfs?: NodeVfs;
	/** ms a blocked synchronous `fs` call may wait before giving up with EIO. 0 disables. */
	syncTimeoutMs?: number;
	/**
	 * Reject if synchronous `fs` turns out to be unavailable. **Default true.**
	 *
	 * The module resolver is synchronous end to end, so without this transport there is no
	 * `require` and nothing runs at all. Failing at startup with the reason named beats every
	 * program failing to resolve its first import with something unrecognizable.
	 *
	 * Set false only if you genuinely intend to run with `fs.promises` alone; a `*Sync` call
	 * will then throw ENOSYS naming why.
	 */
	requireSyncFs?: boolean;
	/**
	 * The network, for a worker started **without** a puter token.
	 *
	 * A token is otherwise what buys network access: the wisp relay credentials behind
	 * `fetch`/sockets are minted by `wisp/relay-token/create`, and a peer is identified to the
	 * signaller by that same token. Supply these instead and the worker never calls
	 * api.puter.com at all.
	 *
	 *   // Any wisp relay, dialed as given.
	 *   net: { wispUrl: MY_RELAY_URL, peerToken: crypto.randomUUID() }
	 *
	 *   // A relay that authenticates over the wisp password extension, which is how the
	 *   // puter relays are reached: `wisp/relay-token/create`'s `server` and `token`.
	 *   net: { wispUrl: server, relayToken: token, peerToken: crypto.randomUUID() }
	 *
	 * Ignored when a puter token is passed, which mints all of it for itself.
	 */
	net?: NodeNetInit;
	/**
	 * Where to load epoxy from, without the trailing slash. `<base>/full.js` is imported
	 * and `<base>/full.wasm` fetched. Defaults to a pinned build on puter's CDN.
	 *
	 * epoxy is the whole network stack — TCP, TLS and everything above it — and it is
	 * fetched from inside the worker before the first `require`, so an unreachable base
	 * means the worker does not start at all, offline included. Point this at a copy you
	 * serve yourself to remove that dependency, or at a local build to test a change to
	 * epoxy itself.
	 *
	 * Cross-origin bases must be CORS-readable: the `import()` is a module fetch and the
	 * wasm arrives through `fetch`.
	 */
	epoxyBase?: string;
}

/** Options shared by `import` and `require`: what the run's process looks like. */
export interface RunOptions {
	/** Complete `process.argv`, `argv[0]` included. Defaults to `["node", path]`. */
	argv?: string[];
	/** Replaces `process.env` wholesale, `TERM` included. */
	env?: Record<string, string>;
}

type OmitW2PFields<T extends object> = Omit<T, "reply" | "to">;
type W2PHandlerRet<T extends object> =
	| Promise<[OmitW2PFields<T>, Transferable[]] | [OmitW2PFields<T>]>
	| [OmitW2PFields<T>, Transferable[]]
	| [OmitW2PFields<T>];

let workers = 0;

export class NodeWorker {
	/**
	 * The host-side filesystem. Mount providers on it, populate memory mounts, read them back
	 * — all synchronously, since none of it crosses a boundary any more.
	 */
	readonly vfs: NodeVfs;
	/** Whether synchronous `fs` works, and if not, why. Resolves with `ready`. */
	readonly capabilities: Promise<NodeFsCapabilities>;

	private worker!: Worker;
	/**
	 * Set by `terminate()`. Checked on both sides of the service-worker await in `ready`,
	 * because until the worker exists `terminate()` has nothing to stop — and without this a
	 * terminate during startup would be a silent no-op followed by a worker appearing.
	 */
	#terminated = false;
	#attachment: Attachment | undefined;
	/**
	 * This worker's sync-fs transport session, and deliberately *this worker's* rather than the
	 * filesystem's.
	 *
	 * It namespaces the virtual URLs the blocking XHR posts to — `{syncPrefix}v{proto}/{sid}/{id}-{op}`
	 * — where `id` is a request counter each worker starts from zero. Taken from the vfs, two workers
	 * sharing one filesystem emitted byte-identical URLs and the service worker answered the second
	 * from the first: a sub-worker would ask for its own entry file, be told the right path, and run
	 * the previous worker's bytes. A `NodeVfs` is explicitly allowed to back several workers, so the
	 * id that separates their traffic cannot be a property of it.
	 */
	readonly #syncSid: string = randomSid();
	/**
	 * Things the worker asked for that live on **this** side of the boundary.
	 *
	 * Peer servers and connections, and the fs-events channel: each owns a socket the
	 * worker cannot see, and each was designed to be closed by the worker asking — over its
	 * port, or by its last watcher leaving. A terminated worker asks for nothing, so every
	 * one of them outlived the worker that created it. For a peer server that is worse than
	 * a leak: while its signaller socket is open the signaller still has that
	 * `(credential, port)` registered, so a `listen(5173)` in the *next* worker competes
	 * with a dead one, and a viewer resolving that port can be handed the corpse.
	 *
	 * Entries drop themselves when they close on their own, so this tracks what is actually
	 * live rather than everything ever created.
	 */
	#hostResources = new Set<{ close(): void }>();
	/** Whether `terminate` may dispose of `vfs`, or only end this session on it. */
	#ownsVfs = false;
	private inflight = new Map<
		string,
		[(reply: NodeP2WReply) => void, (error: Error) => void]
	>();
	private handlers = new Map<
		string,
		(message: NodeW2PMessage) => W2PHandlerRet<NodeW2PReply>
	>();

	private loadPromise: Promise<void>;
	private exitListeners = new Set<(code: number) => void | Promise<void>>();
	ready: Promise<void>;
	console: Console;

	private onmessage(message: NodeP2WReply | NodeW2PMessage) {
		if (message.to == "worker") {
			if (this.inflight.has(message.reply)) {
				let [ok, error] = this.inflight.get(message.reply)!;
				if (message.type === "error") {
					error(fromWireError(message.error));
				} else {
					ok(message);
				}
				this.inflight.delete(message.reply);
			}
		} else if (message.to == "page") {
			let handler = this.handlers.get(message.type);
			if (!handler) throw new Error("unreachable!! register handler for this");

			(async () => {
				let reply = message.reply;
				try {
					let [ret, transfer] = await handler(message);
					this.post({ ...ret, reply, to: "page" }, transfer);
				} catch (err) {
					// Packed rather than posted as-is: structuredClone would strip
					// `code`/`errno` off an fs error on the way across. See
					// ../vfs/errno.ts.
					this.post({
						type: "error",
						error: toWireError(err),
						reply,
						to: "page",
					});
				}
			})();
		}
	}

	private on<T extends NodeMessageType<NodeW2PMessage>>(
		type: T,
		fn: (
			message: Extract<NodeW2PMessage, { type: T }>
		) => W2PHandlerRet<
			NodeW2PMessageReply<Extract<NodeW2PMessage, { type: T }>>
		>
	) {
		this.handlers.set(type, fn as any);
	}

	/**
	 * Register a host-side resource this worker owns, so `terminate` can close it.
	 *
	 * A resource that reports its own closing (`closed`) deregisters itself, which is what
	 * keeps this from growing without bound over a worker that opens many peer
	 * connections. Anything that arrives *after* `terminate` — a handshake that was still
	 * in flight when the worker died — is closed immediately rather than added, because
	 * nothing will ever come back for it.
	 */
	#track<T extends { close(): void; closed?: Promise<void> }>(resource: T): T {
		if (this.#terminated) {
			try {
				resource.close();
			} catch (err) {
				globalThis.console.warn(
					"[node-worker] failed to close a late host resource",
					err
				);
			}
			return resource;
		}

		this.#hostResources.add(resource);
		resource.closed?.then(
			() => this.#hostResources.delete(resource),
			() => this.#hostResources.delete(resource)
		);
		return resource;
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
			this.inflight.set(reply, [(x) => res(x as NodeP2WMessageReply<T>), rej]);
			this.worker.postMessage(
				{ ...message, reply, to: "worker" },
				{ transfer }
			);
		});
	}

	/**
	 * Start a worker, awaiting everything that has to be in place first.
	 *
	 * The recommended entry point, because a constructor cannot reject and a service worker
	 * that fails to register is a startup error worth surfacing rather than a filesystem that
	 * mysteriously hangs later.
	 */
	static async create(
		workerURL: string,
		puterToken: string | undefined,
		cwd: string,
		options?: NodeWorkerOptions
	): Promise<NodeWorker> {
		const worker = new NodeWorker(workerURL, puterToken, cwd, options);
		await worker.ready;
		return worker;
	}

	/**
	 * `puterToken` may be empty, which starts an **anonymous** worker: nothing here calls
	 * api.puter.com, the default filesystem is a memory root with no puterfs under it, and the
	 * network comes from `options.net` instead. See `NodeNetInit`.
	 */
	constructor(
		workerURL: string,
		puterToken: string | undefined,
		cwd: string,
		options?: NodeWorkerOptions
	) {
		let keepalive = !!options?.keepalive;
		// No token, no puterfs — `NodeVfs` mounts its memory overlay at "/" on its own when it
		// is given no puter credentials, which is the whole of what an anonymous root is.
		const vfs =
			options?.vfs ??
			new NodeVfs(puterToken ? { puter: { token: puterToken } } : {});
		this.vfs = vfs;
		// A filesystem this worker made is this worker's to dispose of; one handed in
		// belongs to whoever handed it in and may well outlive several workers. The
		// distinction matters now that a `NodeVfs` holds a change-feed subscription,
		// and with it a socket — disposing a shared one would take that away from
		// every other worker on it.
		this.#ownsVfs = !options?.vfs;

		// NOT created here. The service worker has to be registered and active *before* the
		// worker script is fetched, because that fetch is when the browser decides whether this
		// worker is controlled — and if it is not, every synchronous `fs` call goes to the
		// network instead of to the filesystem. So creation moves into `ready` below, which
		// every public method already awaits.
		let capabilities!: (c: NodeFsCapabilities) => void;
		this.capabilities = new Promise((r) => (capabilities = r));

		this.loadPromise = new Promise((r) =>
			this.on("hi", (_) => {
				r();
				return [{ type: "done" }];
			})
		);

		let console = new Console(this);
		this.console = console;
		this.on("tty", (msg) => {
			this.console.handleTTYState({
				isRaw: msg.isRaw,
				echo: msg.echo,
			});
			return [{ type: "done" }];
		});

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
			let peer = this.#track(
				await handlePeerConnect(
					msg.token,
					msg.code,
					msg.signaller,
					msg.ice,
					msg.anon
				)
			);
			return [
				{
					type: "peer-client",
					readable: peer.readable,
					writable: peer.writable,
				},
				[peer.readable, peer.writable],
			];
		});

		this.on("peer-server", async (msg) => {
			let server = this.#track(
				await handlePeerServe(
					msg.token,
					msg.port,
					msg.signaller,
					msg.ice,
					msg.anon
				)
			);
			return [
				{ type: "peer-server", code: server.code, port: server.port },
				[server.port],
			];
		});

		// Backs node:fs's watchers. The socket lives here rather than in the
		// worker so it's a plain browser WebSocket (the worker's global is
		// epoxy's WISP-tunnelled override) and so one connection serves every
		// watcher across every worker on the token.
		this.on("fs-events", (msg) => {
			let channel = this.#track(handleFsEvents(msg.token, msg.apiOrigin));
			return [{ type: "fs-events", port: channel.port }, [channel.port]];
		});

		// One filesystem operation, over the asynchronous transport. The frame is the same one
		// the synchronous path sends through the service worker, and it goes to the same
		// dispatcher — so the two transports cannot disagree about framing or error shape.
		this.on("vfs", async (msg) => {
			let out = await vfs.handleFrame(msg.frame);
			let frame = out.buffer.slice(
				out.byteOffset,
				out.byteOffset + out.byteLength
			) as ArrayBuffer;
			return [{ type: "vfs", frame }, [frame]];
		});

		// `createReadStream`. Outside the frame protocol because a frame's result is an answer
		// that has already completed, which is the one thing a stream is not. The stream itself
		// is transferred, so the bytes are not copied across.
		this.on("vfs-open-read", async (msg) => {
			let opened =
				msg.fd !== undefined
					? await vfs.openReadFd(msg.fd, {
							start: msg.start ?? 0,
							end: msg.end,
						})
					: await vfs.openRead(msg.path!, {
							start: msg.start ?? 0,
							end: msg.end,
						});
			return [
				{ type: "vfs-open-read", stream: opened.stream, size: opened.size },
				[opened.stream],
			];
		});

		// Every local mutation, forwarded to whatever is watching — deliberately including ones
		// this worker caused itself, which it has already seen on their reply frame.
		//
		// Filtering those out reads as the obvious optimization and is a trap: the same
		// `causedBy` covers a host write (an editor save, with no reply to ride) and a sibling
		// worker sharing these providers, so filtering drops exactly the events nothing else
		// delivers. A duplicate costs a redundant rebuild; a drop costs a dev server that has
		// silently stopped noticing edits.
		vfs.onFsEvent((event) => broadcastLocalFsEvent(event));

		// A mount appearing or disappearing changes answers the worker gives without asking —
		// whether a path's backend has a real positioned read, for one — so re-push it.
		vfs.onMountsChanged((mounts) => {
			if (this.#terminated || !this.worker) return;
			this.send({ type: "vfs-mounts", mounts }).catch(() => {
				// The worker is going away; nothing to tell.
			});
		});

		this.ready = (async () => {
			if (this.#terminated) throw new Error("terminated before start");

			let syncPrefix: string | undefined;
			if (options?.swURL) {
				try {
					this.#attachment = await attachSession(
						this.#syncSid,
						(frame) => vfs.handleFrame(frame, this.#syncSid),
						{ swURL: options.swURL, swScope: options.swScope, workerURL }
					);
					syncPrefix = this.#attachment.prefix;
				} catch (err) {
					if (options.requireSyncFs !== false) throw err;
					globalThis.console.warn(
						"[node-worker] synchronous filesystem unavailable",
						err
					);
				}
			} else if (options?.requireSyncFs !== false) {
				throw new SyncFsUnavailable({
					sync: false,
					reason: "no-sw",
					detail:
						"pass `swURL` (the url of dist/sw.js) to enable synchronous fs",
				});
			}

			// Checked again: registering a service worker is a round trip, and `terminate()`
			// may well have been called during it.
			if (this.#terminated) throw new Error("terminated before start");

			this.worker = new Worker(workerURL, {
				name: "node-worker-" + workers++,
				type: "module",
			});
			this.worker.onmessage = (e) => this.onmessage(e.data);

			await this!.loadPromise;

			let reply = await this.send<NodeInitMessage>(
				{
					type: "init",
					puter: puterToken ?? "",
					net: options?.net,
					epoxyBase: options?.epoxyBase,
					cwd,
					keepalive,
					vfs: {
						sid: this.#syncSid,
						proto: NODEFS_PROTO,
						syncPrefix,
						timeoutMs: options?.syncTimeoutMs ?? SYNC_TIMEOUT_MS,
						mounts: vfs.snapshot(),
					},
					console: {
						isTTY: console.isTTY,
						stdin: console.readable,
						stdout: console.writableOut,
						stderr: console.writableErr,
					},
				},
				[console.readable, console.writableOut, console.writableErr]
			);
			capabilities(reply.capabilities);

			if (!reply.capabilities.sync && options?.requireSyncFs !== false) {
				throw new SyncFsUnavailable(reply.capabilities);
			}
		})();
		// Nothing necessarily awaits `capabilities` if `ready` rejected first.
		this.ready.catch(() =>
			capabilities({ sync: false, reason: "probe-failed" })
		);
	}

	async setCwd(cwd: string) {
		await this.ready;
		await this.send({ type: "cwd", cwd });
	}

	// -------------------------------------------- the filesystem, from the host
	//
	// These all used to be page↔worker messages. They are ordinary calls into `this.vfs` now,
	// which means they are **synchronous underneath** — the `async` signatures are kept only so
	// existing callers do not have to change. Reach for `worker.vfs` directly for the synchronous
	// forms and for anything the old message set could not express (mounting your own provider,
	// listing mounts, watching for changes).
	//
	//   const proj = worker.vfs.mountMemory("/proj");
	//   proj.write([
	//     { path: "package.json", data: pkgJson },
	//     { path: "src/main.js",  data: src },
	//   ]);
	//   await worker.setCwd("/proj");
	//   await worker.import("/proj/src/main.js");

	async registerVirtualModule(path: string, code: string) {
		this.vfs.addVirtualFile(path, code);
	}
	async removeVirtualModule(path: string) {
		this.vfs.removeVirtualFile(path);
	}

	/**
	 * Create a memory-backed directory at `root`.
	 *
	 * `replace` swaps out an existing mount at the same root instead of throwing, which is what
	 * re-populating a project between runs wants.
	 */
	async mountMemory(
		root: string,
		options?: { readOnly?: boolean; replace?: boolean }
	) {
		this.vfs.mountMemory(root, options);
	}

	async unmountMemory(root: string) {
		this.vfs.unmountMemory(root);
	}

	/**
	 * Write entries into the memory mount at `root`, or into the overlay over the root mount when
	 * `root` is "/".
	 *
	 * Entry paths are relative to the mount root, and files create their own parent directories —
	 * an entry with no `data` is only needed for a deliberately empty one. Strings are encoded as
	 * UTF-8.
	 *
	 * `options.transfer` is accepted and **ignored**. It used to hand the underlying buffers to
	 * the worker instead of copying them, and it detached every `Uint8Array` and `ArrayBuffer`
	 * you passed. There is no boundary to cross any more, so the copy it was avoiding is a single
	 * local one and the hazard is simply gone.
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
		void options;
		return this.vfs.memory(root).write(files);
	}

	/** Remove paths (relative to `root`) from a memory mount. */
	async removeMemory(root: string, paths: string[]) {
		this.vfs.memory(root).remove(paths);
	}

	/**
	 * Read one file out of a memory mount, or `undefined` if the path is absent or a directory.
	 * `path` is relative to `root`.
	 */
	async readMemory(
		root: string,
		path: string
	): Promise<Uint8Array | undefined> {
		return this.vfs.memory(root).read(path);
	}

	/**
	 * List a directory in a memory mount, or `undefined` if the path is absent or a file. `path`
	 * is relative to `root`; `""` and `"/"` both mean the root itself.
	 *
	 * `since` reports only what was modified after that time, which is what makes "what did this
	 * run touch?" cheap even over a tree with a `node_modules` in it.
	 */
	async listMemory(
		root: string,
		path: string,
		options?: { recursive?: boolean; since?: number }
	): Promise<MemListEntry[] | undefined> {
		return this.vfs.memory(root).list(path, options);
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
		// Set first, and independently of whether the worker exists yet: creation is deferred
		// behind service-worker registration, so `terminate()` during startup has nothing to
		// stop — and without this flag it would be a silent no-op followed by a worker
		// appearing anyway.
		if (this.#terminated) return;
		this.#terminated = true;

		// Tell the service worker to stop relaying for this session, so a request in flight
		// fails immediately rather than sitting out its deadline.
		this.#attachment?.detach();
		this.#attachment = undefined;

		// Peer servers and connections, and the fs-events channel. All of these are closed
		// by the worker *asking*, and the worker is about to stop being able to ask — see
		// `#hostResources`. A peer server in particular has to go now rather than whenever
		// the page unloads, because the signaller keeps its port registered for exactly as
		// long as its socket is open.
		let resources = [...this.#hostResources];
		this.#hostResources.clear();
		for (let resource of resources) {
			try {
				resource.close();
			} catch (err) {
				globalThis.console.warn(
					"[node-worker] failed to close a host resource",
					err
				);
			}
		}

		// The host owns this session's open files, and they outlive the worker unless dropped —
		// which for a memory mount means leaking the contents of unlinked files, kept alive on
		// purpose for exactly as long as a handle refers to them. Dirty buffers are deliberately
		// not flushed: a worker that died did not ask for its pending writes to be published.
		//
		// A filesystem this worker created goes further and is disposed of outright,
		// since nothing else can be holding it — that also releases its change-feed
		// subscription, which would otherwise keep a socket open for the life of the
		// page. See `#ownsVfs`.
		if (this.#ownsVfs) this.vfs.dispose();
		else this.vfs.closeSession(this.#syncSid);

		this.worker?.terminate();
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
