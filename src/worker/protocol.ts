import { ConsoleSettings } from "./console";

interface NodeMessageBase {
	type: string;
	reply: string;
} 

export interface NodeInitMessage extends NodeMessageBase {
	type: "init";
	puter: string;
	cwd: string;
	console: ConsoleSettings;
}
export interface NodeInitReply extends NodeMessageBase {
	type: "init";
}

export interface NodeCwdMessage extends NodeMessageBase {
	type: "cwd";
	cwd: string;
}

export interface NodeExecuteMessage extends NodeMessageBase {
	type: "execute";
	module: "esm" | "cjs";
	target: string;
}
export interface NodeExecuteReply extends NodeMessageBase {
	type: "execute";
}

export interface NodeVModuleAddMessage extends NodeMessageBase {
	type: "vmodule-add";
	path: string;
	code: string;
}
export interface NodeVModuleRemoveMessage extends NodeMessageBase {
	type: "vmodule-remove";
	path: string;
}

export interface NodeSetTtyMessage extends NodeMessageBase {
	type: "set-tty";
	isTTY: boolean;
}

export interface NodeEmptyReply extends NodeMessageBase {
	type: "done";
}
export interface NodeErrorReply extends NodeMessageBase {
	type: "error";
	error: Error;
}

export type NodeMessageType<T extends NodeMessageBase> = T["type"]; 

type Message2Reply =
	| [NodeInitMessage, NodeInitReply]
	| [NodeCwdMessage, NodeEmptyReply]
	| [NodeExecuteMessage, NodeExecuteReply]
	| [NodeVModuleAddMessage, NodeEmptyReply]
	| [NodeVModuleRemoveMessage, NodeEmptyReply]
	| [NodeSetTtyMessage, NodeEmptyReply];

type NodeMessageTransform<T> = T extends [any, any] ? T[0] : never;
export type NodeMessage = NodeMessageTransform<Message2Reply>;
type NodeReplyTransform<T> = T extends [any, any] ? T[1] : never;
export type NodeReply = NodeReplyTransform<Message2Reply> | NodeErrorReply | { type: "hi" };

type NodeMessageReplyTransform<M2R, T> = M2R extends [any, any] ? T extends M2R[0] ? M2R[1] : never : never;
export type NodeMessageReply<T extends NodeMessage> = NodeMessageReplyTransform<Message2Reply, T>;
