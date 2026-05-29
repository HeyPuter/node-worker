// Forward to the impl in src/worker/node/process.ts. Named exports cover the
// process surface so bare `require('process').env` from inside node_modules/
// hits the real values rather than the synthetic namespace wrapper.
//
// stdin/stdout/stderr are deliberately omitted: they're populated by
// initConsole *after* this module's named-export bindings are snapshotted, so
// a named export would be perpetually undefined. Consumers that need live
// stdio should `import process from 'process'` and read the default — that
// reference stays in sync because it's the same live object.
import process from '../../node/process';

export const env = process.env;
export const platform = process.platform;
export const arch = process.arch;
export const pid = process.pid;
export const ppid = process.ppid;
export const argv = process.argv;
export const argv0 = process.argv0;
export const execPath = process.execPath;
export const execArgv = process.execArgv;
export const version = process.version;
export const versions = process.versions;
export const features = process.features;

export const cwd = process.cwd;
export const chdir = process.chdir;
export const nextTick = process.nextTick;
export const emitWarning = process.emitWarning;
export const on = process.on;
export const once = process.once;
export const off = process.off;
export const addListener = process.addListener;
export const removeListener = process.removeListener;
export const removeAllListeners = process.removeAllListeners;
export const listeners = process.listeners;
export const listenerCount = process.listenerCount;
export const emit = process.emit;
export const kill = process.kill;
export const exit = process.exit;
export const hrtime = process.hrtime;
export const uptime = process.uptime;
export const binding = process.binding;

export default process;
