import { NodeMessage, NodeReply } from "../protocol";
import { DistributiveOmit } from "../util";

import { init as epoxyInit } from "./epoxy";
import { setPuterCWD, setPuterToken } from "./state";
import { require } from "./module/cjs";
import { esmImport } from "./module/esm";
import { registerVirtualSource, deregisterVirtualSource } from "./module/resolve";
import { initConsole, setIsTTY, setTTYStateChangeListener } from "./console";

function send(reply: string, msg: DistributiveOmit<NodeReply, "reply">, transfer?: Transferable[]) {
	postMessage({ reply, ...msg }, { transfer });
}
function sendEmpty(reply: string) {
	send(reply, { type: "done" });
}

setTTYStateChangeListener((change) => {
	postMessage({ type: "tty", reply: "", ...change } satisfies NodeReply);
});

async function onMessage({ reply, ...m }: NodeMessage) {
	try {
		if (m.type === "init") {
			setPuterToken(m.puter);
			setPuterCWD(m.cwd);
			initConsole(m.console);

			await epoxyInit();

			send(reply, { type: "init" });
		} else if (m.type === "cwd") {
			setPuterCWD(m.cwd);

			sendEmpty(reply);
		} else if (m.type === "execute") {
			if (m.module === "esm")
				await esmImport(m.target);
			else if (m.module === "cjs")
				await require(m.target);

			send(reply, { type: "execute" });
		} else if (m.type === "vmodule-add") {
			registerVirtualSource(m.path, m.code);

			sendEmpty(reply);
		} else if (m.type === "vmodule-remove") {
			deregisterVirtualSource(m.path);

			sendEmpty(reply);
		} else if (m.type === "set-tty") {
			setIsTTY(m.isTTY);

			sendEmpty(reply);
		}
	} catch (err) {
		let error = err instanceof Error ? err : new Error(err as any);
		send(reply, { type: "error", error });
	}
}

self.onmessage = (e: MessageEvent) => {
	onMessage(e.data as NodeMessage);
}

postMessage({ type: "hi" } as NodeReply);
