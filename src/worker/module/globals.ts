// Node exposes a handful of values as globals that aren't part of the web
// platform. CJS gets them as function-scope parameters via the harness in
// ./cjs.ts, ESM has no per-module wrapper so it sees them via globalThis.
// Both paths read from the same NODE_GLOBALS object so they stay in sync.

import internalModules from "../node";
import {
	setTimeoutWrap,
	setIntervalWrap,
	setImmediateWrap,
	clearTimeoutWrap,
	clearIntervalWrap,
	clearImmediateWrap,
} from "../node/timers";

export const NODE_GLOBALS = {
	process: internalModules.process,
	Buffer: internalModules.buffer.Buffer,
	global: globalThis,
	globalThis,
	setImmediate: setImmediateWrap,
	clearImmediate: clearImmediateWrap,
	queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
	setTimeout: setTimeoutWrap,
	clearTimeout: clearTimeoutWrap,
	setInterval: setIntervalWrap,
	clearInterval: clearIntervalWrap,
};

export type NodeGlobals = typeof NODE_GLOBALS;

// Install Node-only entries on globalThis for ESM (and any code that touches
// globalThis.X directly). The timer wrappers go here too so ESM Node code
// (and node-core sources that read globalThis.setInterval) gets the same
// ref-aware Timeout objects as CJS Node code.
let nodeOnly = [
	"process",
	"Buffer",
	"global",
	"setImmediate",
	"clearImmediate",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
] as const;
for (let k of nodeOnly) {
	(globalThis as any)[k] = NODE_GLOBALS[k];
}
