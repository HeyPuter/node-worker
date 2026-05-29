import "./early-import";

import { NodeP2WEmptyReply, NodeP2WMessage } from "../protocol";

import { init as epoxyInit } from "./epoxy";
import { setPuterCWD, setPuterToken } from "./state";
import { fetchUserInfo } from "./puter";
import { require } from "./module/cjs";
import { esmImport } from "./module/esm";
import { registerVirtualSource, deregisterVirtualSource } from "./module/resolve";
import { initConsole, setIsTTY } from "./console";
import { InboundReply, send, setMessageHandler } from "./conn";
import { drain, setKeepaliveEnabled } from "./keepalive";

let EMPTY: Omit<NodeP2WEmptyReply, "to" | "reply"> = { type: "done" };

setMessageHandler(async (m: NodeP2WMessage): Promise<InboundReply> => {
	if (m.type === "init") {
		setPuterToken(m.puter);
		setPuterCWD(m.cwd);
		initConsole(m.console);
		setKeepaliveEnabled(!!m.keepalive);
		await epoxyInit();
		await fetchUserInfo();
		return { type: "init" };
	}
	if (m.type === "cwd") {
		setPuterCWD(m.cwd);
		return EMPTY;
	}
	if (m.type === "execute") {
		if (m.module === "esm") await esmImport(m.target);
		else if (m.module === "cjs") await require(m.target);
		await drain();
		return { type: "execute" };
	}
	if (m.type === "vmodule-add") {
		registerVirtualSource(m.path, m.code);
		return EMPTY;
	}
	if (m.type === "vmodule-remove") {
		deregisterVirtualSource(m.path);
		return EMPTY;
	}
	if (m.type === "set-tty") {
		setIsTTY(m.isTTY);
		return EMPTY;
	}

	let _exhaustive: never = m;
	throw new Error(`unknown P2W message: ${(m as any).type}`);
});

await send("hi", {});
