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
}
export interface NodeExecuteReply extends NodeP2WMessageBase {
	type: "execute";
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

type W2PMessage2Reply =
	| [NodeWorkerReadyMessage, NodeW2PEmptyReply]
	| [NodeTtyInfoMessage, NodeW2PEmptyReply]
	| [NodePeerClientMessage, NodePeerClientReply]
	| [NodePeerServerMessage, NodePeerServerReply]
	| [NodeFsEventsMessage, NodeFsEventsReply];

export type NodeW2PMessage = NodeMessageTransform<W2PMessage2Reply>;
export type NodeW2PReply =
	| NodeReplyTransform<W2PMessage2Reply>
	| NodeW2PErrorReply;
export type NodeW2PMessageReply<T extends NodeW2PMessage> =
	NodeMessageReplyTransform<W2PMessage2Reply, T>;
