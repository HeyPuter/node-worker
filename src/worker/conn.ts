import {
	NodeMessageType,
	NodeP2WMessage,
	NodeP2WReply,
	NodeW2PMessage,
	NodeW2PMessageReply,
	NodeW2PReply,
} from "../protocol";
import { DistributiveOmit, genuid } from "../util";

// Worker → page messaging. `inflight` tracks W2P sends awaiting their reply.
// Kept private; callers go through `send()`.
const inflight = new Map<
	string,
	[(reply: NodeW2PReply) => void, (error: Error) => void]
>();

export function send<T extends NodeMessageType<NodeW2PMessage>>(
	type: T,
	msg: DistributiveOmit<
		Extract<NodeW2PMessage, { type: T }>,
		"type" | "reply" | "to"
	>,
	transfer?: Transferable[]
): Promise<NodeW2PMessageReply<Extract<NodeW2PMessage, { type: T }>>> {
	let reply = genuid();
	return new Promise((res, rej) => {
		inflight.set(reply, [(x) => res(x as any), rej]);
		postMessage({ reply, type, to: "page", ...msg }, { transfer });
	});
}

// What an inbound P2W handler returns: the reply body (without the
// `reply`/`to` envelope, which conn supplies). Errors thrown from the handler
// are turned into a `{ type: "error", error }` reply automatically.
export type InboundReply = DistributiveOmit<NodeP2WReply, "reply" | "to">;
export type InboundHandler = (
	msg: NodeP2WMessage
) => InboundReply | Promise<InboundReply>;

let inboundHandler: InboundHandler | null = null;

export function setMessageHandler(handler: InboundHandler) {
	if (inboundHandler) {
		throw new Error("conn message handler already registered");
	}
	inboundHandler = handler;
}

self.onmessage = async (e: MessageEvent) => {
	const message: NodeP2WMessage | NodeW2PReply = e.data;

	// Replies to a previous send().
	if (message.to === "page") {
		const entry = inflight.get(message.reply);
		if (!entry) return;
		const [ok, error] = entry;
		inflight.delete(message.reply);
		if (message.type === "error") error(message.error);
		else ok(message);
		return;
	}

	// Inbound P2W messages — hand off to the registered handler and post its
	// return value back as the reply.
	if (message.to !== "worker" || !inboundHandler) return;
	let body: InboundReply;
	try {
		body = await inboundHandler(message);
	} catch (err) {
		const error = err instanceof Error ? err : new Error(err as any);
		body = { type: "error", error };
	}
	postMessage({ reply: message.reply, to: "worker", ...body });
};
