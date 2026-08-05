# node-worker

Node.js-compatible runtime running transformed code in a Worker with node globals.

## Starting a worker

`NodeWorker.create(workerURL, puterToken, cwd, options)` is the entry point. The second
argument decides which of the two starts you get: a puter token makes the worker that user's,
and an empty one makes it **anonymous** — nothing in the runtime calls api.puter.com, and the
filesystem and network are whatever you supply instead.

`swURL` is needed either way: the module resolver is synchronous end to end, so without the
service worker backing synchronous `fs` there is no working `require` and nothing runs. Startup
verifies it with one probe and rejects with `SyncFsUnavailable` naming the reason, rather than
letting the first `readFileSync` hang. Pass `requireSyncFs: false` only if you genuinely intend
to run on `fs.promises` alone.

### Authenticated

```js
import { NodeWorker } from "node-worker";
import workerURL from "node-worker/worker?url";
import swURL from "node-worker/sw?url";

const worker = await NodeWorker.create(workerURL, puterToken, "/project", { swURL });
await worker.import("/project/index.js", { argv: ["node", "/project/index.js"] });
```

### Anonymous

```js
import { NodeWorker } from "node-worker";
import workerURL from "node-worker/worker?url";
import swURL from "node-worker/sw?url";

const worker = await NodeWorker.create(workerURL, "", "/project", {
	swURL,
	// Optional. Without it the worker has no network at all.
	net: {
		wispUrl: "wss://anura.pro/",
		peerToken: localStorage.getItem("peer") ?? crypto.randomUUID(),
	},
});

// Nothing is mounted under "/" but memory, so put the code there yourself.
const project = worker.vfs.mountMemory("/project");
project.write([
	{ path: "package.json", data: pkgJson },
	{ path: "index.js", data: src },
]);

await worker.import("/project/index.js", { argv: ["node", "/project/index.js"] });
```

What differs from the authenticated start:

- **The filesystem is yours to provide.** The root is the memory overlay with nothing under it, so a fresh anonymous worker has an empty `/` and a memory `/tmp`. Populate it with `worker.vfs.mountMemory(...)`, or mount a real backend like `createDirectoryHandleProvider` over a File System Access handle, or your own `VfsProvider` for OPFS/IndexedDB/a fetch.
- **The network comes from `options.net`.** Any wisp-compliant relay works.
- **`fs.watch` only sees local mutations.** Mutations made through this worker's own providers still reach watchers, and `fs.watchFile` falls back to polling.
