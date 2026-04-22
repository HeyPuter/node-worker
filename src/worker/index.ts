import { NodeMessageType, NodeP2WMessage, NodeP2WReply, NodeW2PMessage, NodeW2PMessageReply, NodeW2PReply } from "../protocol";
import { DistributiveOmit, genuid } from "../util";

import { init as epoxyInit } from "./epoxy";
import { setPuterCWD, setPuterToken } from "./state";
import { require } from "./module/cjs";
import { esmImport } from "./module/esm";
import { registerVirtualSource, deregisterVirtualSource } from "./module/resolve";
import { initConsole, setIsTTY } from "./console";

function sendBack(reply: string, msg: DistributiveOmit<NodeP2WReply, "reply" | "to">, transfer?: Transferable[]) {
	postMessage({ reply, to: "worker", ...msg }, { transfer });
}
function sendBackEmpty(reply: string) {
	sendBack(reply, { type: "done" });
}

let inflight = new Map<
	string,
	[(reply: NodeW2PReply) => void, (error: Error) => void]
>();

export function send<T extends NodeMessageType<NodeW2PMessage>>(type: T, msg: DistributiveOmit<Extract<NodeW2PMessage, { type: T }>, "type" | "reply" | "to">, transfer?: Transferable[]): Promise<NodeW2PMessageReply<Extract<NodeW2PMessage, { type: T }>>> {
	let reply = genuid();
	return new Promise((res, rej) => {
		inflight.set(reply, [(x) => res(x as any), rej]);
		postMessage({ reply, type, to: "page", ...msg }, { transfer });
	});
}

async function onMessage({ reply, ...m }: NodeP2WMessage) {
	try {
		if (m.type === "init") {
			setPuterToken(m.puter);
			setPuterCWD(m.cwd);
			initConsole(m.console);

			await epoxyInit();

			sendBack(reply, { type: "init" });
		} else if (m.type === "cwd") {
			setPuterCWD(m.cwd);

			sendBackEmpty(reply);
		} else if (m.type === "execute") {
			if (m.module === "esm")
				await esmImport(m.target);
			else if (m.module === "cjs")
				await require(m.target);

			sendBack(reply, { type: "execute" });
		} else if (m.type === "vmodule-add") {
			registerVirtualSource(m.path, m.code);

			sendBackEmpty(reply);
		} else if (m.type === "vmodule-remove") {
			deregisterVirtualSource(m.path);

			sendBackEmpty(reply);
		} else if (m.type === "set-tty") {
			setIsTTY(m.isTTY);

			sendBackEmpty(reply);
		}
	} catch (err) {
		let error = err instanceof Error ? err : new Error(err as any);
		sendBack(reply, { type: "error", error });
	}
}

self.onmessage = (e: MessageEvent) => {
	let message: NodeP2WMessage | NodeW2PReply = e.data;
	if (message.to == "worker") {
		onMessage(message);
	} else if (message.to == "page") {
		if (inflight.has(message.reply)) {
			let [ok, error] = inflight.get(message.reply)!;
			if (message.type === "error") {
				error(message.error);
			} else {
				ok(message);
			}
			inflight.delete(message.reply);
		}
	}
}

await send("hi", {});
