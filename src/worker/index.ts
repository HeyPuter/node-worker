// Must stay first: it initializes primordials before any node-core module that
// reads them is evaluated. Note that this module must not reference the
// injected globals (`process`, `internalBinding`, `primordials`) even once —
// rollup's inject plugin would prepend an import for them *above* this line,
// pulling the node subgraph in ahead of the bootstrap.
import "./early-import";

import { NodeP2WEmptyReply, NodeP2WMessage } from "../protocol";

import { init as epoxyInit } from "./epoxy";
import { setPuterCWD, setPuterToken } from "./state";
import {
	apiStatsEnabled,
	fetchUserInfo,
	reportRequestStats,
	resetRequestStats,
} from "./puter";
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
		// Every puter API call is a round trip, and on the resolver's path a
		// *blocking* one, so the per-endpoint call count is the number worth
		// watching when tuning resolution or readdir. Opt-in via
		// NODE_WORKER_API_STATS; `reportRequestStats` decides where it goes.
		let stats = apiStatsEnabled();
		if (stats) resetRequestStats();

		if (m.module === "esm") await esmImport(m.target);
		else if (m.module === "cjs") await require(m.target);
		await drain();

		if (stats) reportRequestStats();
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
