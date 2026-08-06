import { ConsoleSettings } from "./worker/console";
import type { WireError } from "./vfs/errno";
import type { MountSnapshot, NodeFsCapabilities, VfsInit } from "./vfs/wire";

interface NodeMessageBase {
	type: string;
	to: string;
	reply: string;
}
interface NodeP2WMessageBase extends NodeMessageBase {
	to: "worker";
}
interface NodeW2PMessageBase extends NodeMessageBase {
	to: "page";
}

export interface NodeP2WEmptyReply extends NodeMessageBase {
	to: "worker";
	type: "done";
}

/**
 * A handler threw.
 *
 * `WireError` rather than `Error` because **`structuredClone` of an `Error` keeps only
 * `name`, `message`, `stack` and `cause`** — every own property, `code` and `errno`
 * included, is silently dropped. This channel used to carry a bare `Error`, so an fs
 * error crossing it arrived without its `code` and every
 * `catch (e) { if (e.code !== "ENOENT") throw e }` upstream misbehaved. See
 * `toWireError`/`fromWireError` in ./vfs/errno.ts.
 */
export interface NodeP2WErrorReply extends NodeMessageBase {
	to: "worker";
	type: "error";
	error: WireError;
}

/**
 * Where the network comes from when there is no puter token.
 *
 * Both of these are otherwise minted by authenticated api calls — the wisp relay
 * credentials by `wisp/relay-token/create`, the peer identity by the signaller
 * against `authToken`. Supplying them directly is what makes an anonymous run
 * possible: the worker never touches api.puter.com, and the only two things it
 * loses are TURN relays (`peer/generate-turn` is authed, so ICE falls back to the
 * STUN list `peer/signaller-info` hands out unauthenticated) and puterfs, which
 * the host simply does not mount.
 */
export interface NodeNetInit {
	/**
	 * The relay address, dialed **as given**. Any wisp-compliant relay will do.
	 *
	 * Nothing is parsed out of it, which is what makes a wisp v1 URL
	 * (`wss://host/<relay-token>/`, as puter-js's `generateWispV1URL()` builds it)
	 * work by simply arriving intact: the token rides in the path and the relay
	 * reads it there.
	 */
	wispUrl?: string;
	/**
	 * A relay token to send over the wisp password extension (0x02), as the password
	 * with an empty user.
	 *
	 * Only for a relay that authenticates that way — which is how the puter relays
	 * are reached with credentials from `wisp/relay-token/create`, whose `server` and
	 * `token` map onto `wispUrl` and this. Omit it and no extension is negotiated at
	 * all, so put the token in `wispUrl`'s path instead if that is what your relay
	 * expects. Supplying it makes 0x02 **required**: a relay that does not offer the
	 * extension fails the handshake rather than proceeding unauthenticated.
	 */
	relayToken?: string;
	/**
	 * This peer's identity at the signaller, sent as `anonToken`. Any opaque
	 * string; a uuid is the obvious choice. Persist it and the peer keeps its
	 * identity across reloads.
	 */
	peerToken?: string;
}

export interface NodeInitMessage extends NodeP2WMessageBase {
	type: "init";
	/** Empty for an anonymous run, in which case `net` supplies the network. */
	puter: string;
	net?: NodeNetInit;
	cwd: string;
	console: ConsoleSettings;
	keepalive?: boolean;
	/**
	 * Everything needed to reach the host filesystem, including the mount snapshot — so the
	 * worker has it in hand before any `fs` call is possible and there is no window in which
	 * a capability question has no answer.
	 */
	vfs: VfsInit;
}
export interface NodeInitReply extends NodeP2WMessageBase {
	type: "init";
	/**
	 * Whether the *synchronous* filesystem transport actually works, verified by one probe
	 * round trip during init rather than assumed.
	 *
	 * This is the design's safety valve. Every way service-worker interception can silently
	 * fail — a scope that does not cover the worker script, a policy blocking synchronous XHR,
	 * a worker that never activated — otherwise shows up as a *hang* at the first
	 * `readFileSync`. One probe turns all of them into a startup state with a reason attached.
	 */
	capabilities: NodeFsCapabilities;
}

export interface NodeCwdMessage extends NodeP2WMessageBase {
	type: "cwd";
	cwd: string;
}

export interface NodeExecuteMessage extends NodeP2WMessageBase {
	type: "execute";
	module: "esm" | "cjs";
	target: string;
	/**
	 * The complete `process.argv` for this run, `argv[0]` included. Defaults to
	 * `["node", target]`.
	 *
	 * A run's argv belongs to the run, not to the worker: it is what lets a package
	 * binary be driven the way a shell drives it, and the caller supplies the whole
	 * array rather than just the extras so that `argv0` and the script slot are
	 * under its control too.
	 */
	argv?: string[];
	/**
	 * Replaces `process.env`'s contents for this run — it is not merged into what is
	 * already there. The caller owns the environment, including the `TERM` the
	 * runtime otherwise defaults to, so that one run can never inherit a variable
	 * some earlier run happened to set.
	 */
	env?: Record<string, string>;
}
export interface NodeExecuteReply extends NodeP2WMessageBase {
	type: "execute";
	/** `process.exitCode`, or the code passed to `process.exit`. */
	exitCode: number;
}

/**
 * The host's mount table changed.
 *
 * Pushed rather than polled because the worker needs it to answer questions that cannot wait
 * for a round trip — whether a path's backend has a real positioned read, for one, which is
 * asked in the middle of a read and decides whether to buffer the whole file. A stale snapshot
 * can only pick a suboptimal strategy; it can never misroute an operation, since every call
 * carries an absolute path the host resolves against its own authoritative table.
 */
export interface NodeVfsMountsMessage extends NodeP2WMessageBase {
	type: "vfs-mounts";
	mounts: MountSnapshot[];
}

export interface NodeSetTtyMessage extends NodeP2WMessageBase {
	type: "set-tty";
	isTTY: boolean;
	/**
	 * Terminal dimensions, as `process.stdout.columns`/`rows`.
	 *
	 * Only the host knows these — the worker cannot see the terminal — and a CLI that
	 * lays out progress output needs them to be real, so this is re-sent on resize.
	 * Omitted fields leave the current values alone.
	 */
	columns?: number;
	rows?: number;
}

export type NodeMessageType<T extends NodeMessageBase> = T["type"];
type NodeMessageTransform<T> = T extends [any, any] ? T[0] : never;
type NodeReplyTransform<T> = T extends [any, any] ? T[1] : never;
type NodeMessageReplyTransform<M2R, T> = M2R extends [any, any]
	? T extends M2R[0]
		? M2R[1]
		: never
	: never;

type P2WMessage2Reply =
	| [NodeInitMessage, NodeInitReply]
	| [NodeCwdMessage, NodeP2WEmptyReply]
	| [NodeExecuteMessage, NodeExecuteReply]
	| [NodeVfsMountsMessage, NodeP2WEmptyReply]
	| [NodeSetTtyMessage, NodeP2WEmptyReply];

export type NodeP2WMessage = NodeMessageTransform<P2WMessage2Reply>;
export type NodeP2WReply =
	| NodeReplyTransform<P2WMessage2Reply>
	| NodeP2WErrorReply;
export type NodeP2WMessageReply<T extends NodeP2WMessage> =
	NodeMessageReplyTransform<P2WMessage2Reply, T>;

export interface NodeW2PEmptyReply extends NodeMessageBase {
	to: "page";
	type: "done";
}

/** As {@link NodeP2WErrorReply}, in the other direction. */
export interface NodeW2PErrorReply extends NodeMessageBase {
	to: "page";
	type: "error";
	error: WireError;
}

export interface NodeWorkerReadyMessage extends NodeW2PMessageBase {
	type: "hi";
}

export interface NodeTtyInfoMessage extends NodeW2PMessageBase {
	type: "tty";
	isRaw?: boolean;
	echo?: boolean;
}

export interface NodePeerClientMessage extends NodeW2PMessageBase {
	type: "peer-client";
	token: string;
	code: string;
	signaller: string;
	ice: RTCIceServer[];
	/** `token` is an `anonToken` rather than a puter `authToken`. */
	anon?: boolean;
}

export interface NodePeerClientReply extends NodeW2PMessageBase {
	type: "peer-client";
	readable: ReadableStream<Uint8Array<ArrayBuffer>>;
	writable: WritableStream<Uint8Array<ArrayBuffer>>;
}

export interface NodePeerServerMessage extends NodeW2PMessageBase {
	type: "peer-server";
	token: string;
	port: number;
	signaller: string;
	ice: RTCIceServer[];
	/** `token` is an `anonToken` rather than a puter `authToken`. */
	anon?: boolean;
}

export interface NodePeerServerReply extends NodeW2PMessageBase {
	type: "peer-server";
	code: string;
	port: MessagePort;
}

// A puterfs mutation, normalized from the api's `item.*` socket.io events (or
// synthesized locally by the worker's own fs calls). Kinds map onto puter's
// wire events; `node:fs`'s rename/change distinction is applied later, in
// worker/node/fs/watch.ts, because it depends on what the watcher is watching.
export interface PuterFsEvent {
	kind: "added" | "updated" | "removed" | "moved";
	/** Absolute puterfs path of the entry the event is about. */
	path: string;
	isDir: boolean;
	/** `moved` only: where the entry came from. */
	oldPath?: string;
	/**
	 * `removed` only: the parent survived and only its children were dropped
	 * (how the api reports emptying Trash).
	 */
	descendantsOnly?: boolean;
}

// What the page pushes down the fs-events MessagePort. `state` lets a watcher
// tell "nothing has changed" from "we're not listening right now" — the latter
// is when the poll fallback in watchFile earns its keep.
export type FsEventsToWorker =
	| { type: "event"; event: PuterFsEvent }
	| { type: "state"; connected: boolean }
	| { type: "error"; message: string; fatal: boolean };

// ...and what the worker sends back up it.
export type FsEventsToPage = { type: "close" };

export interface NodeFsEventsMessage extends NodeW2PMessageBase {
	type: "fs-events";
	token?: string;
	apiOrigin: string;
}

export interface NodeFsEventsReply extends NodeW2PMessageBase {
	type: "fs-events";
	port: MessagePort;
}

/**
 * `process.exit` was called. The worker is the process, so this is the process
 * dying: the page terminates it on receipt.
 *
 * Sent fire-and-forget — the worker throws immediately afterwards to stop the code
 * that followed the `exit()` call from running, and it may well be gone before this
 * message's reply could be delivered.
 */
/**
 * One filesystem operation, over the asynchronous transport.
 *
 * The frame is byte-identical to what the synchronous path sends through the service worker, and
 * that is the point: one codec and one dispatch table means a framing or error-envelope bug
 * cannot exist on one transport and not the other. Transferred in both directions, so the
 * crossing is zero-copy.
 *
 * Failures ride *inside* the frame rather than as a `NodeW2PErrorReply`, because the reply also
 * carries watch events and cache invalidations that a thrown error would discard.
 */
export interface NodeVfsMessage extends NodeW2PMessageBase {
	type: "vfs";
	frame: ArrayBuffer;
}
export interface NodeVfsReply extends NodeW2PMessageBase {
	type: "vfs";
	frame: ArrayBuffer;
}

/**
 * A stream over a path or an open fd, for `createReadStream`.
 *
 * Separate from the frame protocol because a frame's result is an answer that has already
 * completed, which is the one thing a stream is not — so this is reachable only from the
 * asynchronous transport. There is no synchronous streaming, and never was.
 *
 * `fd` rather than `path` when the caller supplied one: a handle may hold bytes the backend has
 * not seen, and those are the file as far as that fd is concerned.
 */
export interface NodeVfsOpenReadMessage extends NodeW2PMessageBase {
	type: "vfs-open-read";
	path?: string;
	fd?: number;
	start?: number;
	end?: number;
}
export interface NodeVfsOpenReadReply extends NodeW2PMessageBase {
	type: "vfs-open-read";
	stream: ReadableStream<Uint8Array>;
	size?: number;
}

export interface NodeExitMessage extends NodeW2PMessageBase {
	type: "exit";
	code: number;
}

type W2PMessage2Reply =
	| [NodeWorkerReadyMessage, NodeW2PEmptyReply]
	| [NodeTtyInfoMessage, NodeW2PEmptyReply]
	| [NodePeerClientMessage, NodePeerClientReply]
	| [NodePeerServerMessage, NodePeerServerReply]
	| [NodeExitMessage, NodeW2PEmptyReply]
	| [NodeVfsMessage, NodeVfsReply]
	| [NodeVfsOpenReadMessage, NodeVfsOpenReadReply]
	| [NodeFsEventsMessage, NodeFsEventsReply];

export type NodeW2PMessage = NodeMessageTransform<W2PMessage2Reply>;
export type NodeW2PReply =
	| NodeReplyTransform<W2PMessage2Reply>
	| NodeW2PErrorReply;
export type NodeW2PMessageReply<T extends NodeW2PMessage> =
	NodeMessageReplyTransform<W2PMessage2Reply, T>;
