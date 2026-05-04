// Node exposes a handful of values as globals that aren't part of the web
// platform. CJS gets them as function-scope parameters via the harness in
// ./cjs.ts, ESM has no per-module wrapper so it sees them via globalThis.
// Both paths read from the same NODE_GLOBALS object so they stay in sync.

import internalModules from "../node";

export const NODE_GLOBALS = {
	process: internalModules.process,
	Buffer: internalModules.buffer.Buffer,
	global: globalThis,
	globalThis,
	setImmediate: globalThis.setImmediate,
	clearImmediate: globalThis.clearImmediate,
	queueMicrotask: globalThis.queueMicrotask,
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
	setInterval: globalThis.setInterval,
	clearInterval: globalThis.clearInterval,
};

export type NodeGlobals = typeof NODE_GLOBALS;

// Install Node-only entries on globalThis for ESM (and any code that touches
// globalThis.X directly).
let nodeOnly = ["process", "Buffer", "global"] as const;
for (let k of nodeOnly) {
	(globalThis as any)[k] = NODE_GLOBALS[k];
}
