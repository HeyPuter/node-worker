# node-worker

Node.js-compatible runtime running transformed code in a Worker with node globals.

## Starting a worker

`NodeWorker.create(workerURL, puterToken, cwd, options)` is the entry point. The second
argument decides which of the two starts you get: a puter token makes the worker that user's,
and an empty one makes it **anonymous** — nothing in the runtime calls api.puter.com, and the
filesystem and network are whatever you supply instead.

`swURL` is needed either way: the module resolver is synchronous end to end, so without the
service worker backing synchronous `fs` there is no working `require` and nothing runs.
Pass `requireSyncFs: false` only if you genuinely intend to run on `fs.promises` alone.

### Authenticated

```js
import { NodeWorker } from "node-worker";
import workerURL from "node-worker/worker?url";
import swURL from "node-worker/sw?url";

const worker = await NodeWorker.create(workerURL, puterToken, "/project", {
	swURL,
});
await worker.import("/project/index.js", {
	argv: ["node", "/project/index.js"],
});
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

await worker.import("/project/index.js", {
	argv: ["node", "/project/index.js"],
});
```

What differs from the authenticated start:

- **The filesystem is yours to provide.** The root is the memory overlay with nothing under it, so a fresh anonymous worker has an empty `/` and a memory `/tmp`. Populate it with `worker.vfs.mountMemory(...)`, or mount a real backend like `createDirectoryHandleProvider` over a File System Access handle, or your own `VfsProvider` for OPFS/IndexedDB/a fetch.
- **The network comes from `options.net`.** Any [Wisp](https://github.com/MercuryWorkshop/wisp-protocol)-compliant relay works.
- **`fs.watch` only sees local mutations.** Mutations made through this worker's own providers still reach watchers.

## The filesystem cache

An authenticated worker puts a read cache in front of puterfs — stats, directory listings,
negative lookups and file contents — so a repeated read costs nothing and a directory listed
in full answers every miss under it locally. It is on by default, and it is only sound
because the same token buys a change feed to invalidate it with: puterfs's socket names every
path that moves, and when the socket is unavailable (an app launched with an app token cannot
authenticate one) the runtime falls back to polling the account's change counter, which says
_that_ something moved without saying what.

```js
new NodeVfs({
	puter: {
		token,
		cache: {
			maxBytes: 64 * 1024 * 1024, // file contents held; 0 caches metadata only
			maxFileBytes: 8 * 1024 * 1024, // larger files stream through uncached
			maxStaleMs: 3000, // tolerated window of unreported change
			prefetch: true, // turn a tree walk into subtree listings; see below
			enabled: true,
		},
	},
});
```

### Walks

A tree walk — a search tool, a build, anything that lists a directory and then lists each of
its subdirectories — otherwise costs one request per directory, and a `node_modules` with two
thousand of them costs two thousand requests. A ripgrep over one workspace was ~1000
`GET /fs/readdir`, the last 44 of them answered with 429.

So the cache watches for a **descent**: a listing that misses inside a directory whose own
listing it just answered. Nothing about a first listing says a walk is happening — a lone `ls`
must not drag a subtree over the wire — but the second one does, and the reply to a bounded
recursive listing rooted at the _parent_ answers the whole neighbourhood the walk is about to
ask for. Measured over five random trees of each shape, walked to the bottom:

| tree                          | requests without | with |
| ----------------------------- | ---------------- | ---- |
| ≤4 levels, ≤4 wide (232 dirs) | 232              | 59   |
| ≤6 levels, ≤4 wide (618 dirs) | 618              | 38   |
| ≤9 levels, ≤3 wide (445 dirs) | 445              | 52   |

On by default for puterfs, where a listing is a network round trip, and off elsewhere — over a
mount that is already local it trades bytes for round trips that were never being paid.
`prefetch: { depth, maxEntries }` tunes it.

Requests that come back 429 are retried with a jittered backoff, honouring `Retry-After` when
CORS lets it be read, and one 429 holds the account's other in-flight requests back rather than
letting each rediscover the same limit. `apiStats()` reports `(429 retried)` and
`(429 gave up)`. Only 429 — a 5xx says nothing about whether a mutation landed, and nothing in
this api is idempotent.

`vfs.cacheStats()` reports hits, misses and bytes held, alongside `apiStats()` (what left the
browser) and `opStats()` (what the worker asked for) — the three together are where a run's
filesystem traffic actually went. `vfs.flushCache()` drops it all.

Other mounts can have one too, via `mount(root, provider, { cache })`. It is on by default for
a **read-only** mount, since nothing can write through one, and off otherwise — there is no
change feed for a `FileSystemDirectoryHandle`, so "nobody else touches this" is a claim only
the consumer can make.
