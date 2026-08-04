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
import {
	addVirtualFile,
	listMemory,
	mountMemory,
	readMemory,
	removeMemory,
	removeVirtualFile,
	unmountMemory,
	writeMemory,
} from "./node/fs/vfs/virtual";
import { setArgv, setEnv, takeExitCode } from "./node/process";
import { ProcessExit } from "./exit";
import { flushConsole, initConsole, setIsTTY, setTTYSize } from "./console";
import { InboundReply, send, setMessageHandler } from "./conn";
import { drain, installPlatformRefs, setKeepaliveEnabled } from "./keepalive";

let EMPTY: Omit<NodeP2WEmptyReply, "to" | "reply"> = { type: "done" };

setMessageHandler(async (m: NodeP2WMessage): Promise<InboundReply> => {
	if (m.type === "init") {
		setPuterToken(m.puter);
		setPuterCWD(m.cwd);
		initConsole(m.console);
		setKeepaliveEnabled(!!m.keepalive);
		// Before anything can compile wasm — epoxy's init below is itself the first
		// caller, and a package's bundler is the one that matters.
		installPlatformRefs();
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

		setArgv(m.argv ?? ["node", m.target]);
		if (m.env) setEnv(m.env);

		let exitCode: number;
		try {
			if (m.module === "esm") await esmImport(m.target);
			else if (m.module === "cjs") await require(m.target);
			await drain();
			exitCode = takeExitCode();
		} catch (err) {
			// `process.exit` does not wait for the event loop, so this deliberately
			// skips the drain a normal return goes through. The page is terminating
			// us anyway; replying keeps the exit code correct for a caller that
			// chooses not to.
			if (!(err instanceof ProcessExit)) throw err;
			exitCode = err.code;
		}

		// Everything the program printed has to be across the boundary before the reply,
		// because the reply is what lets the host tear this worker down.
		await flushConsole();

		if (stats) reportRequestStats();
		return { type: "execute", exitCode };
	}
	if (m.type === "vmodule-add") {
		addVirtualFile(m.path, m.code);
		return EMPTY;
	}
	if (m.type === "vmodule-remove") {
		removeVirtualFile(m.path);
		return EMPTY;
	}
	if (m.type === "mem-mount") {
		mountMemory(m.root, { readOnly: m.readOnly, replace: m.replace });
		return EMPTY;
	}
	if (m.type === "mem-unmount") {
		unmountMemory(m.root);
		return EMPTY;
	}
	if (m.type === "mem-write") {
		let { written, bytes } = writeMemory(m.root, m.entries);
		return { type: "mem-write", written, bytes };
	}
	if (m.type === "mem-remove") {
		removeMemory(m.root, m.paths);
		return EMPTY;
	}
	if (m.type === "mem-read") {
		let data = readMemory(m.root, m.path);
		// `readMemory` already copied, so the buffer is ours to hand over rather than
		// clone across the boundary.
		return data
			? [{ type: "mem-read", data }, [data.buffer as ArrayBuffer]]
			: { type: "mem-read" };
	}
	if (m.type === "mem-list") {
		let entries = listMemory(m.root, m.path, {
			recursive: m.recursive,
			since: m.since,
		});
		return { type: "mem-list", entries };
	}
	if (m.type === "set-tty") {
		setIsTTY(m.isTTY);
		setTTYSize({ columns: m.columns, rows: m.rows });
		return EMPTY;
	}

	let _exhaustive: never = m;
	throw new Error(`unknown P2W message: ${(m as any).type}`);
});

await send("hi", {});
