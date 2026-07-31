// The transport-agnostic request protocol every filesystem operation is written
// against.
//
// puterfs is reachable two ways — an async `fetch` and a *blocking*
// XMLHttpRequest — and the fs surface has to offer both (`readFile` and
// `readFileSync` are the same semantics over the same api). Writing each
// operation twice is what this replaces: an operation is a generator that
// *describes* the requests it needs and receives the responses, and a driver
// (./driver.ts) performs them with whichever transport the caller asked for.
//
// ./readdir-recursive.ts proved the shape before this existed — its paging and
// depth-horizon logic is driven by the sync fs, the async fs, and the module
// resolver from one implementation. These types are that idea generalized to
// carry POST bodies, multipart uploads, request headers, raw bytes and HTTP
// status.
//
// The property that makes it worth doing: **a plan that never yields is
// automatically safe under the blocking driver.** An operation served from
// memory, from a zip, or from cache simply returns without describing a request,
// so it satisfies a sync caller and an async caller through the same code at no
// cost. That is what lets the layers below this file be written once.
//
// This module is deliberately a leaf: types only, no runtime imports. The fs
// subgraph sits inside a module-init cycle (see ./lazy-base.ts) and anything
// imported this widely has to be safe to evaluate first.

import type { PuterBodyInit, PuterHeaders } from "../../puter";

/**
 * One backend round trip, in the shape `fetchPuter`/`fetchPuterSync` take.
 *
 * `body` decides the method, and its *presence* is what matters rather than its
 * contents: `undefined` is a GET, a plain object is a JSON POST, and a
 * `(form) => void` builder is a multipart POST (how whole-file writes upload).
 * So `body: {}` is not the same as omitting it — it is an empty JSON POST, which
 * is exactly what `/df` wants. `handleBodySettings` in ../../puter.ts is the
 * dispatch.
 *
 * Note that a GET is CORS-*simple* only while it has no custom headers — the
 * token rides as `?auth_token=` for precisely that reason — so anything set in
 * `headers` costs a preflight, i.e. doubles the round trips. Only `Range` uses
 * it today.
 */
export interface FsRequest {
	url: string;
	body?: PuterBodyInit;
	headers?: PuterHeaders;
}

/**
 * The result of one round trip.
 *
 * Both `bytes` and `status` are always real, and nothing here decides whether a
 * response is an *error*: that is the operation's business, not the driver's. A
 * 416 means "no bytes at that offset" to a positioned read, "empty file" to a
 * stream, and nothing at all to a stat — so a driver that threw on non-`ok`
 * would have to be told what to tolerate, and every operation would have to
 * declare it. Handing back the response and letting the plan decide is both
 * smaller and more honest.
 */
export interface FsResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly bytes: Uint8Array;
	/**
	 * The body parsed as JSON — decoded on first call, memoized after, and
	 * `undefined` when the body is not JSON.
	 *
	 * Deliberately lazy and deliberately non-throwing. The previous drivers
	 * called `decode()` eagerly, which throws `SyntaxError` on any non-JSON body
	 * — so a file read and a stat could not share a driver at all. Here a read
	 * ignores `json()` and a stat ignores `bytes`, and neither pays for the
	 * other.
	 */
	json(): any;
}

/**
 * A filesystem operation: yields the requests it needs, receives their
 * responses, returns its result.
 *
 * Two rules hold for every plan in the tree, neither expressible in the type
 * system:
 *
 *   - **A plan may not need anything a blocking transport cannot give it.** No
 *     `await`, no streaming response, no waiting on a lock — because the same
 *     plan runs under `runSync`, where the worker thread is inside an XHR and
 *     nothing else can make progress. Streaming lives outside this protocol
 *     entirely (see `ByteSource` in ./vfs/provider.ts).
 *   - **A plan must never call `runSync` itself.** Doing so would freeze the
 *     worker in the middle of an operation the caller believes is async, and it
 *     would stay invisible until a large file showed up.
 */
export type Plan<T> = Generator<FsRequest, T, FsResponse>;
