// Page-side socket.io client for puterfs change notifications.
//
// Puter has no filesystem-watch api, but the backend already pushes
// `item.added` / `item.updated` / `item.removed` / `item.moved` over socket.io
// to every socket joined to the authenticated user's room — the same stream
// puter.js consumes for cache invalidation. That is what backs `fs.watch` in
// the worker.
//
// This lives in the page rather than the worker for three reasons:
//   - the worker's `globalThis.WebSocket` is epoxy's WISP-tunnelled override
//     (worker/epoxy/globals.ts), so a page-side socket is a plain browser one;
//   - one connection is shared by every watcher in every worker on the token,
//     and it survives `execute` boundaries;
//   - it sits outside worker/keepalive.ts accounting, so the socket by itself
//     can never hold a run open — only watchers ref.
//
// The protocol is hand-rolled instead of pulling in socket.io-client: the
// backend is socket.io@4.8 / engine.io@6.6 with `allowEIO3` unset, we only ever
// receive server-to-client events, and websocket-only means none of the polling
// transport or upgrade machinery is reachable.

import { FsEventsToPage, FsEventsToWorker, PuterFsEvent } from "../protocol";

// engine.io packet types (first character of a frame).
const EIO_OPEN = "0";
const EIO_CLOSE = "1";
const EIO_PING = "2";
const EIO_PONG = "3";
const EIO_MESSAGE = "4";

// socket.io packet types (first character of an engine.io MESSAGE payload).
const SIO_CONNECT = "0";
const SIO_DISCONNECT = "1";
const SIO_EVENT = "2";
const SIO_CONNECT_ERROR = "4";

// socket.io-client's own reconnection defaults; there is no reason to be more
// aggressive than the client the backend was built against.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5000;
const RECONNECT_JITTER = 0.5;

interface EngineHandshake {
	sid: string;
	pingInterval: number;
	pingTimeout: number;
}

function coerceBool(value: unknown): boolean {
	// The api reports `is_dir` as a boolean on the v2 routes and as 1|0 on the
	// legacy ones, and every `item.*` payload comes from the legacy projection.
	return value === true || value === 1 || value === "1";
}

// Turns one `item.*` payload into the normalized shape the worker consumes.
// Returns null for events that carry no usable path, and for `item.pending`,
// which announces an upload that has not landed yet — the completing write
// emits `item.added`/`item.updated` immediately after, so forwarding both would
// report a file that does not exist yet.
function normalize(name: string, data: any): PuterFsEvent | null {
	if (!data || typeof data.path !== "string" || !data.path) return null;
	let isDir = coerceBool(data.is_dir ?? data.isDir);

	switch (name) {
		case "item.added":
			return { kind: "added", path: data.path, isDir };
		case "item.updated":
			return { kind: "updated", path: data.path, isDir };
		case "item.removed":
			return {
				kind: "removed",
				path: data.path,
				isDir,
				descendantsOnly: coerceBool(data.descendants_only),
			};
		case "item.moved": {
			// The new FSController emits `from_path`; LegacyFSController and
			// WebDAVController emit `old_path`. Both are live.
			let oldPath = data.from_path ?? data.old_path;
			return {
				kind: "moved",
				path: data.path,
				isDir,
				oldPath: typeof oldPath === "string" ? oldPath : undefined,
			};
		}
		// `item.renamed` is deliberately absent: puter-js and the desktop both
		// listen for it, but no backend path has ever emitted it — rename goes
		// out as `item.updated`.
		default:
			return null;
	}
}

// Splits an engine.io MESSAGE payload into its socket.io type and JSON body.
// Wire shape is `<type>[<namespace>,][<ackId>]<json>`; we speak only the
// default namespace and never send an ack-requiring event, but a well-behaved
// parser has to skip both fields rather than assume they are absent.
function parseSocketIoPacket(payload: string): { type: string; body: any } {
	let type = payload[0];
	let rest = payload.slice(1);

	if (rest.startsWith("/")) {
		let comma = rest.indexOf(",");
		rest = comma === -1 ? "" : rest.slice(comma + 1);
	}

	let digits = 0;
	while (digits < rest.length && rest[digits] >= "0" && rest[digits] <= "9") {
		digits++;
	}
	rest = rest.slice(digits);

	let body: any = undefined;
	if (rest.length > 0) {
		try {
			body = JSON.parse(rest);
		} catch {
			body = undefined;
		}
	}

	return { type, body };
}

class FsEventsHub {
	#token: string;
	#url: string;
	#ports = new Set<MessagePort>();

	#ws: WebSocket | undefined;
	#connected = false;
	#attempt = 0;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#watchdog: ReturnType<typeof setTimeout> | undefined;
	#pingInterval = 25000;
	#pingTimeout = 20000;
	/** Set when the token itself is bad, which no amount of retrying fixes. */
	#dead = false;
	#onEmpty: () => void;

	constructor(token: string, apiOrigin: string, onEmpty: () => void) {
		this.#token = token;
		this.#onEmpty = onEmpty;

		let url = new URL("/socket.io/", apiOrigin);
		url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
		url.searchParams.set("EIO", "4");
		url.searchParams.set("transport", "websocket");
		this.#url = url.toString();
	}

	/** Hands the worker one end of a channel fed by this hub. */
	attach(): MessagePort {
		let { port1: rx, port2: tx } = new MessageChannel();
		tx.onmessage = (e: MessageEvent<FsEventsToPage>) => {
			if (e.data?.type === "close") this.#detach(tx);
		};
		tx.start();

		this.#ports.add(tx);
		// Tell a late joiner where things stand, so it doesn't have to wait for
		// the next state change to know whether it is actually listening.
		this.#post(tx, { type: "state", connected: this.#connected });
		if (this.#dead) {
			this.#post(tx, {
				type: "error",
				message: "fs events unavailable: socket auth rejected",
				fatal: true,
			});
		}

		if (this.#ports.size === 1 && !this.#dead) this.#connect();
		return rx;
	}

	#detach(tx: MessagePort) {
		if (!this.#ports.delete(tx)) return;
		tx.close();
		if (this.#ports.size === 0) this.close();
	}

	close() {
		this.#clearTimers();
		for (let tx of this.#ports) tx.close();
		this.#ports.clear();
		this.#teardownSocket();
		this.#onEmpty();
	}

	/** Push an event this page produced, rather than one the socket delivered. */
	inject(event: PuterFsEvent) {
		this.#broadcast({ type: "event", event });
	}

	#post(tx: MessagePort, msg: FsEventsToWorker) {
		try {
			tx.postMessage(msg);
		} catch {
			// A closed port is not worth reporting; the worker is gone.
		}
	}

	#broadcast(msg: FsEventsToWorker) {
		for (let tx of this.#ports) this.#post(tx, msg);
	}

	#clearTimers() {
		if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
		if (this.#watchdog !== undefined) clearTimeout(this.#watchdog);
		this.#reconnectTimer = undefined;
		this.#watchdog = undefined;
	}

	#teardownSocket() {
		let ws = this.#ws;
		this.#ws = undefined;
		if (!ws) return;
		ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
		try {
			ws.close();
		} catch {
			// Already closing.
		}
	}

	#setConnected(connected: boolean) {
		if (this.#connected === connected) return;
		this.#connected = connected;
		this.#broadcast({ type: "state", connected });
	}

	#connect() {
		if (this.#ws || this.#dead || this.#ports.size === 0) return;

		let ws: WebSocket;
		try {
			ws = new WebSocket(this.#url);
		} catch (err) {
			console.warn("[node-worker] [fs-events] socket construction failed", err);
			this.#scheduleReconnect();
			return;
		}
		this.#ws = ws;

		ws.onmessage = (e) => {
			if (typeof e.data !== "string") return;
			this.#onFrame(ws, e.data);
		};
		ws.onerror = () => {
			// `error` is always followed by `close`, which does the reconnecting.
			// Engine.io gives no detail here beyond "the socket failed".
			console.warn("[node-worker] [fs-events] socket error");
		};
		ws.onclose = () => {
			if (this.#ws !== ws) return;
			this.#teardownSocket();
			this.#setConnected(false);
			this.#scheduleReconnect();
		};
	}

	#onFrame(ws: WebSocket, frame: string) {
		if (frame.length === 0) return;
		let type = frame[0];
		let payload = frame.slice(1);

		if (type === EIO_PING) {
			// engine.io v4 has the *server* ping and the client pong.
			ws.send(EIO_PONG);
			this.#armWatchdog();
			return;
		}
		if (type === EIO_OPEN) {
			this.#onHandshake(ws, payload);
			return;
		}
		if (type === EIO_CLOSE) {
			// The server is shutting the transport down; `onclose` follows.
			return;
		}
		if (type === EIO_MESSAGE) {
			this.#onMessage(payload);
			return;
		}
		// PONG/UPGRADE/NOOP: we never ping and never upgrade, so nothing to do.
	}

	#onHandshake(ws: WebSocket, payload: string) {
		let handshake: EngineHandshake;
		try {
			handshake = JSON.parse(payload);
		} catch {
			console.warn("[node-worker] [fs-events] malformed handshake");
			this.#teardownSocket();
			this.#scheduleReconnect();
			return;
		}

		this.#pingInterval = handshake.pingInterval ?? 25000;
		this.#pingTimeout = handshake.pingTimeout ?? 20000;
		this.#armWatchdog();

		// The backend reads the token from `socket.handshake.auth.auth_token`
		// and joins the socket to the user's room; there is no cookie or query
		// fallback. This is the socket.io CONNECT packet for the default
		// namespace with `auth` as its payload.
		ws.send(
			EIO_MESSAGE + SIO_CONNECT + JSON.stringify({ auth_token: this.#token })
		);
	}

	#armWatchdog() {
		if (this.#watchdog !== undefined) clearTimeout(this.#watchdog);
		// A silent socket is worse than a closed one: no `close` event fires
		// when the connection is black-holed, so watchers would sit believing
		// they are live. Give the server one full interval plus its own timeout
		// before declaring the transport dead.
		this.#watchdog = setTimeout(() => {
			console.warn("[node-worker] [fs-events] ping timeout, reconnecting");
			this.#teardownSocket();
			this.#setConnected(false);
			this.#scheduleReconnect();
		}, this.#pingInterval + this.#pingTimeout);
	}

	#onMessage(payload: string) {
		let { type, body } = parseSocketIoPacket(payload);

		if (type === SIO_CONNECT) {
			this.#attempt = 0;
			this.#setConnected(true);
			return;
		}

		if (type === SIO_CONNECT_ERROR) {
			// Auth is checked once, in the handshake middleware, so a rejection
			// here will reject identically forever. Retrying a bad token is what
			// puter.js gets wrong (it registers no `connect_error` handler at
			// all) — stop, and tell the worker why.
			let message =
				(body && (body.message || body.data?.reason)) ?? "socket auth failed";
			console.warn("[node-worker] [fs-events] connect error", body);
			this.#dead = true;
			this.#clearTimers();
			this.#teardownSocket();
			this.#setConnected(false);
			this.#broadcast({
				type: "error",
				message: `fs events unavailable: ${message}`,
				fatal: true,
			});
			return;
		}

		if (type === SIO_DISCONNECT) {
			this.#setConnected(false);
			this.#teardownSocket();
			this.#scheduleReconnect();
			return;
		}

		if (type === SIO_EVENT) {
			if (!Array.isArray(body) || typeof body[0] !== "string") return;
			let event = normalize(body[0], body[1]);
			if (event) this.#broadcast({ type: "event", event });
		}
	}

	#scheduleReconnect() {
		if (this.#dead || this.#ports.size === 0) return;
		if (this.#reconnectTimer !== undefined) return;

		let backoff = Math.min(
			RECONNECT_BASE_MS * 2 ** this.#attempt,
			RECONNECT_MAX_MS
		);
		this.#attempt++;
		let delay = backoff * (1 + RECONNECT_JITTER * (Math.random() * 2 - 1));

		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#connect();
		}, delay);
	}
}

// One hub per (token, origin). Several NodeWorkers on the same account share a
// single socket; each gets its own port.
let hubs = new Map<string, FsEventsHub>();

/**
 * Fan a locally-produced mutation out to every attached watcher.
 *
 * The filesystem lives on this side now, so its own mutations have no socket echo to wait for.
 * The session that *caused* one already learns about it on the reply frame of the call it made —
 * that is what keeps write-then-observe immediate even while a worker is parked in a blocking
 * call — so this exists for the other direction: telling everyone *else* sharing those providers.
 *
 * A no-op when nothing is watching, since a hub only exists once a watcher subscribes.
 */
export function broadcastLocalFsEvent(event: PuterFsEvent): void {
	for (const hub of hubs.values()) hub.inject(event);
}

export function handleFsEvents(token: string, apiOrigin: string): MessagePort {
	let key = `${apiOrigin} ${token}`;
	let hub = hubs.get(key);
	if (!hub) {
		hub = new FsEventsHub(token, apiOrigin, () => {
			if (hubs.get(key) === hub) hubs.delete(key);
		});
		hubs.set(key, hub);
	}
	return hub.attach();
}
