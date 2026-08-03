import { ConsoleSettings } from "./worker/console";

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

export interface NodeP2WErrorReply extends NodeMessageBase {
	to: "worker";
	type: "error";
	error: Error;
}

export interface NodeInitMessage extends NodeP2WMessageBase {
	type: "init";
	puter: string;
	cwd: string;
	console: ConsoleSettings;
	keepalive?: boolean;
}
export interface NodeInitReply extends NodeP2WMessageBase {
	type: "init";
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

export interface NodeVModuleAddMessage extends NodeP2WMessageBase {
	type: "vmodule-add";
	path: string;
	code: string;
}
export interface NodeVModuleRemoveMessage extends NodeP2WMessageBase {
	type: "vmodule-remove";
	path: string;
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

/**
 * One entry to place in an in-memory mount.
 *
 * `path` is relative to the mount root; a leading "/" is accepted and ignored, so
 * `"src/main.js"` and `"/src/main.js"` mean the same thing. Absent `data` creates a
 * directory — files create their own parents, so that is only needed for a
 * deliberately empty one.
 */
export interface NodeMemEntry {
	path: string;
	data?: Uint8Array;
	mtimeMs?: number;
}

export interface NodeMemMountMessage extends NodeP2WMessageBase {
	type: "mem-mount";
	root: string;
	/** Reject every mutation with EROFS. */
	readOnly?: boolean;
	/** Replace an existing mount at this root instead of failing. */
	replace?: boolean;
}
export interface NodeMemUnmountMessage extends NodeP2WMessageBase {
	type: "mem-unmount";
	root: string;
}
export interface NodeMemWriteMessage extends NodeP2WMessageBase {
	type: "mem-write";
	/** "/" targets the overlay over the root mount. */
	root: string;
	entries: NodeMemEntry[];
}
export interface NodeMemRemoveMessage extends NodeP2WMessageBase {
	type: "mem-remove";
	root: string;
	paths: string[];
}
export interface NodeMemWriteReply extends NodeP2WMessageBase {
	type: "mem-write";
	/** Entries actually placed, so the host can sanity-check a bulk populate. */
	written: number;
	bytes: number;
}

/** One node as reported by `mem-list`. Paths are relative to the mount root. */
export interface NodeMemListEntry {
	path: string;
	kind: "file" | "dir";
	/** 0 for directories. */
	size: number;
	mtimeMs: number;
}

export interface NodeMemReadMessage extends NodeP2WMessageBase {
	type: "mem-read";
	root: string;
	path: string;
}
export interface NodeMemReadReply extends NodeP2WMessageBase {
	type: "mem-read";
	/** Absent when the path does not exist or is a directory. */
	data?: Uint8Array;
}

export interface NodeMemListMessage extends NodeP2WMessageBase {
	type: "mem-list";
	root: string;
	path: string;
	recursive?: boolean;
	/**
	 * Report only nodes modified strictly after this time. The walk is complete
	 * either way — this bounds the reply, which is the part that has to be cloned
	 * across the worker boundary.
	 */
	since?: number;
}
export interface NodeMemListReply extends NodeP2WMessageBase {
	type: "mem-list";
	/** Absent when the path does not exist or is a file. */
	entries?: NodeMemListEntry[];
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
	| [NodeVModuleAddMessage, NodeP2WEmptyReply]
	| [NodeVModuleRemoveMessage, NodeP2WEmptyReply]
	| [NodeMemMountMessage, NodeP2WEmptyReply]
	| [NodeMemUnmountMessage, NodeP2WEmptyReply]
	| [NodeMemWriteMessage, NodeMemWriteReply]
	| [NodeMemRemoveMessage, NodeP2WEmptyReply]
	| [NodeMemReadMessage, NodeMemReadReply]
	| [NodeMemListMessage, NodeMemListReply]
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

export interface NodeW2PErrorReply extends NodeMessageBase {
	to: "page";
	type: "error";
	error: Error;
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
	token: string;
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
	| [NodeFsEventsMessage, NodeFsEventsReply];

export type NodeW2PMessage = NodeMessageTransform<W2PMessage2Reply>;
export type NodeW2PReply =
	| NodeReplyTransform<W2PMessage2Reply>
	| NodeW2PErrorReply;
export type NodeW2PMessageReply<T extends NodeW2PMessage> =
	NodeMessageReplyTransform<W2PMessage2Reply, T>;
