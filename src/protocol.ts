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
type NodeMessageReplyTransform<M2R, T> = M2R extends [any, any] ? T extends M2R[0] ? M2R[1] : never : never;

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
export type NodeP2WMessageReply<T extends NodeP2WMessage> = NodeMessageReplyTransform<P2WMessage2Reply, T>;

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

type W2PMessage2Reply =
	| [NodeWorkerReadyMessage, NodeW2PEmptyReply]
	| [NodeTtyInfoMessage, NodeW2PEmptyReply]

export type NodeW2PMessage = NodeMessageTransform<W2PMessage2Reply>;
export type NodeW2PReply = 
	| NodeReplyTransform<W2PMessage2Reply>
	| NodeW2PErrorReply;
export type NodeW2PMessageReply<T extends NodeW2PMessage> = NodeMessageReplyTransform<W2PMessage2Reply, T>;
