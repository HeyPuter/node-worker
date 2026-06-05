# node-worker

nodejs-compatible runtime running transformed code in a Worker with node globals.

Use by `pnpm i` `pnpm build` ing then importing `NodeWorker` from `dist/index.js` (maps to `src/lib/`) with the `dist/worker.js` sidecar (maps to `src/worker`)
