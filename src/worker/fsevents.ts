// Worker-side end of the puterfs change-notification channel.
//
// The socket itself lives in the page (src/lib/fsevents.ts); this owns the
// MessagePort it hands back and fans events out to whoever is watching. The
// port is opened lazily on the first subscribe and dropped when the last
// subscriber leaves, so a program that never calls `fs.watch` never opens a
// socket.
//
// Deliberately does NOT touch keepalive: the channel is plumbing, not an active
// handle. Watchers ref (see node/fs/watch.ts) — if this reffed too, every run
// that so much as stat'd a file would hang waiting for a socket nobody is
// listening to.

import { send } from "./conn";
import { console_warn } from "./console";
import { FsEventsToWorker, PuterFsEvent } from "../protocol";
import { API_ORIGIN } from "./puter";
import { PUTER_TOKEN } from "./state";

export type { PuterFsEvent };

type Handler = (event: PuterFsEvent) => void;

let handlers = new Set<Handler>();
let port: MessagePort | undefined;
let opening: Promise<void> | undefined;
let connected = false;
let stateHandlers = new Set<(connected: boolean) => void>();

/** Whether the page currently has a live socket. */
export function fsEventsConnected(): boolean {
	return connected;
}

/**
 * Watch the connection state. Used by `watchFile`, which falls back to interval
 * polling only while there is nothing pushing events at it.
 */
export function onFsEventsState(fn: (connected: boolean) => void): () => void {
	stateHandlers.add(fn);
	return () => stateHandlers.delete(fn);
}

function setConnected(value: boolean) {
	if (connected === value) return;
	connected = value;
	for (let fn of [...stateHandlers]) {
		try {
			fn(value);
		} catch (err) {
			console_warn("[node-worker] [fs-events] state handler threw", err);
		}
	}
}

function handleMessage(msg: FsEventsToWorker) {
	if (msg.type === "event") {
		dispatch(msg.event);
		return;
	}
	if (msg.type === "state") {
		setConnected(msg.connected);
		return;
	}
	if (msg.type === "error") {
		// A fatal error means the token was rejected at the handshake and no
		// retry will help. Watchers stay alive and keep reporting local
		// mutations; they just won't see changes made elsewhere.
		console_warn(`[node-worker] [fs-events] ${msg.message}`);
		if (msg.fatal) setConnected(false);
	}
}

function dispatch(event: PuterFsEvent) {
	// Snapshot: a handler closing its watcher mid-dispatch mutates the set.
	for (let fn of [...handlers]) {
		try {
			fn(event);
		} catch (err) {
			console_warn("[node-worker] [fs-events] handler threw", err);
		}
	}
}

function ensurePort(): Promise<void> {
	if (port) return Promise.resolve();
	if (opening) return opening;

	opening = (async () => {
		if (!PUTER_TOKEN) throw new Error("Not authed");
		let res = await send("fs-events", {
			token: PUTER_TOKEN,
			apiOrigin: API_ORIGIN,
		});
		// Everyone may have unsubscribed while the round trip was in flight.
		if (handlers.size === 0) {
			res.port.postMessage({ type: "close" });
			res.port.close();
			return;
		}
		res.port.onmessage = (e: MessageEvent<FsEventsToWorker>) =>
			handleMessage(e.data);
		res.port.start();
		port = res.port;
	})().finally(() => {
		opening = undefined;
	});

	return opening;
}

function closePort() {
	if (!port) return;
	port.postMessage({ type: "close" });
	port.onmessage = null;
	port.close();
	port = undefined;
	setConnected(false);
}

/**
 * Subscribe to puterfs mutations. Returns an unsubscribe function; when the
 * last subscriber unsubscribes the channel is torn down.
 */
export function subscribeFsEvents(fn: Handler): () => void {
	handlers.add(fn);
	ensurePort().catch((err) => {
		console_warn("[node-worker] [fs-events] failed to open channel", err);
	});

	let done = false;
	return () => {
		if (done) return;
		done = true;
		handlers.delete(fn);
		if (handlers.size === 0) closePort();
	};
}

/**
 * Report a mutation this worker just performed, without waiting for the api to
 * echo it back over the socket.
 *
 * Echoes are deliberately NOT deduplicated. The local event is the fast,
 * approximate signal (we don't stat before writing, so a file creation is
 * reported as `updated`); the socket echo that follows carries the api's own
 * classification. node's `fs.watch` is documented as coalescing and
 * occasionally double-reporting, and every real consumer (chokidar and friends)
 * re-stats and dedupes anyway — so an extra event is cheap and a missing one is
 * not.
 */
export function emitLocalFsEvent(event: PuterFsEvent): void {
	if (handlers.size === 0) return;
	dispatch(event);
}
