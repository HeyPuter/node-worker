// `node:console` — reuses upstream Node's own console. `node-core:console`
// resolves (via Rollup fallthrough) to upstream `lib/console.js` →
// `internal/console/global.js`, which builds the global console namespace object
// (methods bound to it, `.Console` attached) exactly as Node does. That object
// is both the module and the global `console.*`.
//
// `global.js` does NOT wire the streams (upstream does that in bootstrap via
// `initializeGlobalConsole`), so we replicate the one meaningful line here:
// bind stdout/stderr lazily to `process`. Lazy means the streams are read on the
// first `console.*` call — after `initConsole()` has populated
// `process.stdout`/`stderr` (see ../console.ts).

// @ts-ignore resolved by the worker Rollup pipeline.
import globalConsole from "node-core:console";
// @ts-ignore resolved by the worker Rollup pipeline.
import consoleConstructor from "node-core:internal/console/constructor";
import process from "./process";

globalConsole[consoleConstructor.kBindStreamsLazy](process);

export const Console = globalConsole.Console;

export default globalConsole as typeof import("node:console");
