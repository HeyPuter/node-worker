// Keep the upstream primordials initializer ahead of the runtime graph. Rollup
// may inject imports into index.ts; this tiny entry has no injectable globals.
import "./node-core/early-import";
import "./platform-primordials";
import "./index";
