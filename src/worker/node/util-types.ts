// `node:util/types` — falls through (via Rollup) to upstream `lib/util/types.js`
// → `internal/util/types.js`, which is now fully functional thanks to the
// pure-JS `internalBinding('types')` shim. Same object backs `node:util`.types.

// @ts-ignore resolved by the worker Rollup pipeline.
import types from "node-core:util/types";

export default types as typeof import("node:util/types");
