// Must stay first: it initializes primordials before any node-core module that
// reads them is evaluated. Note that this module must not reference the
// injected globals (`process`, `internalBinding`, `primordials`) even once —
// rollup's inject plugin would prepend an import for them *above* this line,
// pulling the node subgraph in ahead of the bootstrap.
import "./early-import";

import { NodeP2WEmptyReply, NodeP2WMessage, PuterFsEvent } from "../protocol";

import { init as epoxyInit } from "./epoxy";
import { PUTER_TOKEN, setNet, setPuterCWD, setPuterToken } from "./state";
import {
	apiStatsEnabled,
	fetchUserInfo,
	reportRequestStats,
	resetRequestStats,
	setAnonymousUser,
} from "./puter";
import { require } from "./module/cjs";
import { esmImport } from "./module/esm";
import { emitLocalFsEvent } from "./fsevents";
import {
	invalidateResolved,
	invalidateResolvedSubtree,
} from "./module/resolve";
import { setArgv, setEnv, takeExitCode } from "./node/process";
import { ProcessExit } from "./exit";
import { flushConsole, initConsole, setIsTTY, setTTYSize } from "./console";
import { InboundReply, send, setMessageHandler } from "./conn";
import { drain, installPlatformRefs, setKeepaliveEnabled } from "./keepalive";
// A leaf module (no `process`, no primordials), so a direct edge from the entry is safe here
// where an edge into the fs barrel would not be.
import {
	applyMountSnapshot,
	getHopStats,
	initTransport,
	onReplyMeta,
	resetHopStats,
} from "./node/fs/transport";

let EMPTY: Omit<NodeP2WEmptyReply, "to" | "reply"> = { type: "done" };

setMessageHandler(async (m: NodeP2WMessage): Promise<InboundReply> => {
	if (m.type === "init") {
		setPuterToken(m.puter);
		if (m.net) setNet(m.net);
		setPuterCWD(m.cwd);
		initConsole(m.console);
		setKeepaliveEnabled(!!m.keepalive);
		// Before anything can compile wasm — epoxy's init below is itself the first
		// caller, and a package's bundler is the one that matters.
		installPlatformRefs();
		await epoxyInit();
		// `whoami` is an authenticated call, so an anonymous run has no user to fetch
		// and takes a placeholder one instead — see `setAnonymousUser`.
		if (PUTER_TOKEN) await fetchUserInfo();
		else setAnonymousUser();
		// Last, and reported back: this probes the synchronous filesystem transport with one
		// round trip, so a service worker that is not actually intercepting becomes a startup
		// state the host can act on instead of a hang at the first `readFileSync`.
		// Watch events and resolver-cache invalidations ride the reply of the call that caused
		// them, and this is where they are applied.
		//
		// Both were direct function calls before the filesystem moved: providers called
		// `emitLocalFsEvent` themselves, and the memory-mount API called into the resolver's
		// caches. Losing either fails *silently* — a dev server stops noticing that files
		// changed, and a file the host wrote is answered as "missing" forever, which only shows
		// up on a second run. Registered here rather than imported by the transport so that
		// module keeps no edge into the fsevents or resolver subgraphs.
		onReplyMeta((meta) => {
			if (meta.events) {
				for (let event of meta.events) emitLocalFsEvent(event as PuterFsEvent);
			}
			if (meta.invalidate) {
				for (let path of meta.invalidate.paths ?? []) invalidateResolved(path);
				for (let root of meta.invalidate.subtrees ?? []) {
					invalidateResolvedSubtree(root);
				}
			}
		});

		let capabilities = initTransport(m.vfs);
		return { type: "init", capabilities };
	}
	if (m.type === "cwd") {
		setPuterCWD(m.cwd);
		return EMPTY;
	}
	if (m.type === "execute") {
		setArgv(m.argv ?? ["node", m.target]);
		if (m.env) setEnv(m.env);

		// Every puter API call is a round trip, and on the resolver's path a
		// *blocking* one, so the per-endpoint call count is the number worth
		// watching when tuning resolution or readdir. Opt-in via
		// NODE_WORKER_API_STATS; `reportRequestStats` decides where it goes.
		//
		// Read *after* `setEnv`, which replaces `process.env` wholesale for this run — so
		// checking first meant the flag could only ever be seen if it had been set by some
		// earlier run, and never when passed on the `execute` that wanted it.
		let stats = apiStatsEnabled();
		if (stats) {
			resetRequestStats();
			resetHopStats();
		}

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

		// Reported *before* the flush, not after. `reportRequestStats` prints to the
		// program's own stderr, and the flush below is the only thing that guarantees
		// output has crossed the boundary before the reply — which is what lets the host
		// tear this worker down. Reporting afterwards raced that teardown, so the stats
		// were routinely lost: a miserable way to lose a diagnostic whose whole job is to
		// be read.
		if (stats) reportRequestStats(getHopStats());

		// Everything the program printed has to be across the boundary before the reply,
		// because the reply is what lets the host tear this worker down.
		await flushConsole();

		return { type: "execute", exitCode };
	}
	if (m.type === "vfs-mounts") {
		applyMountSnapshot(m.mounts);
		return EMPTY;
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
