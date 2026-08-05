// The service worker's side channel to the page.
//
// The service worker cannot answer a filesystem request itself — it has no mount table
// and no providers — so it relays: a blocking XHR from the node worker arrives as a
// `fetch` event, the SW hands the frame to the page over a `MessagePort`, the page runs
// the (async) operation, and the answering frame becomes the XHR's response body. The
// node worker's thread is parked inside `send()` for the whole trip, which is the point.
//
// Two browser facts shape every message below, and both are easy to get wrong:
//
//   1. **`MessagePort.postMessage` does not start a stopped service worker;
//      `ServiceWorker.postMessage` does.** So the page always *attaches* through
//      `registration.active.postMessage`, never over a port it happens to be holding.
//      A message sent to a port whose SW instance has been killed is simply lost.
//   2. **A service worker is evicted when idle (~30s) and loses all module state.** Its
//      session registry is therefore a cache, never the truth, and arriving at a cold
//      worker is the *normal* path rather than an edge case. `Rescue` is how it gets
//      its port back, and only a window client can answer it.

/** `<pageClientId>.<nonce>` — the client id lets a restarted SW find the owner directly. */
export type SessionId = string;

/**
 * Page → service worker, over `registration.active.postMessage`, with the page's end of
 * a fresh `MessageChannel` in the transfer list.
 *
 * Sent at startup and again on every `Rescue` and `controllerchange`. The SW always
 * prefers the newest port: from the page's side a stale port is indistinguishable from a
 * live one, so it must be free to mint a replacement at any time.
 */
export interface SwAttach {
	t: "attach";
	sid: SessionId;
	proto: number;
}

/** Service worker → page, over the attach port, once the session is registered. */
export interface SwAttached {
	t: "attached";
	/** The URL prefix the node worker must POST to, derived from `registration.scope`. */
	prefix: string;
	proto: number;
}

/** Page → service worker: this session is finished (`pagehide`, `terminate()`). */
export interface SwDetach {
	t: "detach";
	sid: SessionId;
}

/** Service worker → page: run this request. */
export interface SwOp {
	t: "op";
	seq: number;
	frame: ArrayBuffer;
}

/** Page → service worker: here is the answer. */
export interface SwRes {
	t: "res";
	seq: number;
	frame: ArrayBuffer;
}

/**
 * Page → service worker: this op is still running, don't time it out.
 *
 * Needed because the SW's deadline has to be short enough to be useful and a genuine
 * operation can be slow — a large write into OPFS is not a hung page.
 */
export interface SwProgress {
	t: "progress";
	seq: number;
}

/**
 * Service worker → page: the node worker gave up on this op.
 *
 * The page aborts its controller rather than completing a mutation nobody is waiting
 * for. Reached when the worker's own `xhr.timeout` fires and it posts an abandon
 * request.
 */
export interface SwAbandon {
	t: "abandon";
	seq: number;
}

/**
 * Service worker → **window client** (via `client.postMessage`, not a port): the SW
 * restarted and has no port for this session.
 *
 * The page answers with a fresh {@link SwAttach}. Delivered by `clients.get()` on the
 * client id embedded in the sid, falling back to a broadcast — see the notes at the top
 * of this file for why the SW has to be the one to initiate.
 */
export interface SwRescue {
	t: "rescue";
	sid: SessionId;
}

export type SwToPage = SwAttached | SwOp | SwAbandon;
export type PageToSw = SwAttach | SwDetach | SwRes | SwProgress;

/** The broadcast fallback when `clients.get()` cannot find the owning window. */
export const SW_BROADCAST_CHANNEL = "node-worker-fs";

/** ms the service worker waits for a page to re-attach after a restart. */
export const RESCUE_TIMEOUT_MS = 1500;

/**
 * ms the service worker waits for an answer before failing the request.
 *
 * Refreshed by every {@link SwProgress}. Kept well inside the browsers' own fetch-event
 * ceilings (Chrome ~5 min, Firefox ~300s) so the failure is ours and legible rather than
 * theirs and opaque.
 */
export const OP_TIMEOUT_MS = 15_000;

/**
 * ms the *worker* waits, as the backstop.
 *
 * Longer than `OP_TIMEOUT_MS` on purpose: the SW's own timeout produces a `504` with a
 * readable message, so it should normally win the race. This one exists for the case
 * where there is no service worker left to produce anything — and it is the only limit
 * that holds then, because nothing else in the worker can run while the thread is
 * parked. (`xhr.timeout` is settable on a synchronous request in a worker; the spec only
 * forbids it when the global is a `Window`.)
 */
export const SYNC_TIMEOUT_MS = 20_000;

/** HTTP statuses the service worker answers with. 200 means "an op ran", success or not. */
export const SW_STATUS = {
	/** The frame carries the result, including an in-band ENOENT. */
	ok: 200,
	/** Protocol skew between the page and the service worker. */
	protoMismatch: 400,
	/** No session attached, rescue failed, or the page detached. */
	noSession: 503,
	/** The host did not answer in time. */
	timeout: 504,
} as const;
