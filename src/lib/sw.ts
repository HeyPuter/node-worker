// Registering the service worker and attaching a session to it.
//
// The page is the filesystem host: the service worker relays a blocking request from the node
// worker to here, `handleFrame` answers it, and the answer becomes the XHR's response body.
//
// Everything in this file exists to make one failure mode impossible: a synchronous `fs` call
// that hangs because interception silently is not happening. That is what the scope assertion
// and the startup probe are for — a misconfiguration should be a startup error naming the fix,
// never a worker parked forever.

import { WIRE_PROTO } from "../wire/frame";
import { replyToBrokenFrame, type DispatchResult } from "../wire/router";
import type { NodeFsCapabilities } from "../wire/fs";
import {
	PROGRESS_INTERVAL_MS,
	SW_BROADCAST_CHANNEL,
	SW_PATH_SEGMENT,
	type SessionId,
	type SwToPage,
} from "../wire/sw";

export type FrameHandler = (frame: ArrayBuffer) => Promise<DispatchResult>;

export interface AttachOptions {
	/** `dist/sw.js`, however the consumer's bundler spells its URL. */
	swURL: string;
	/** Registration scope. Defaults to the directory `swURL` sits in. */
	swScope?: string;
	/**
	 * The worker script this session will run, so its scope can be checked before anything
	 * depends on interception working.
	 */
	workerURL: string;
}

export interface Attachment {
	/** Absolute URL prefix the node worker POSTs frames to. */
	prefix: string;
	detach(): void;
}

/** One registration per (url, scope), shared by every session on the page. */
const registrations = new Map<string, Promise<ServiceWorkerRegistration>>();

function registerOnce(
	swURL: string,
	scope: string | undefined
): Promise<ServiceWorkerRegistration> {
	// See the same key in ./fsevents.ts on why NUL, and why as an escape rather than the
	// literal byte: an embedded NUL makes grep treat the file as binary.
	const key = `${swURL}\0${scope ?? ""}`;
	let existing = registrations.get(key);
	if (!existing) {
		existing = navigator.serviceWorker
			.register(swURL, scope ? { scope } : undefined)
			.then(async (reg) => {
				await activeOf(reg);
				return reg;
			});
		// A failed registration must not be cached as the answer forever.
		existing.catch(() => registrations.delete(key));
		registrations.set(key, existing);
	}
	return existing;
}

/**
 * Wait for an active worker.
 *
 * Deliberately not `navigator.serviceWorker.ready`, which resolves only for a registration
 * whose scope contains *this page* — and a scope that covers the worker script but not the page
 * is a perfectly valid arrangement (measured: it intercepts). Awaiting `ready` there would hang
 * forever.
 */
function activeOf(reg: ServiceWorkerRegistration): Promise<ServiceWorker> {
	if (reg.active) return Promise.resolve(reg.active);
	return new Promise((resolve, reject) => {
		const deadline = setTimeout(
			() => reject(new Error("service worker never became active")),
			10_000
		);
		const check = () => {
			if (reg.active) {
				clearTimeout(deadline);
				resolve(reg.active);
				return;
			}
			setTimeout(check, 50);
		};
		check();
	});
}

/**
 * Why interception cannot work here, if it cannot.
 *
 * Returns `undefined` when nothing is obviously wrong — which is not the same as "it works",
 * hence the probe the worker runs afterwards.
 */
export function unsupportedReason(): NodeFsCapabilities | undefined {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return {
			sync: false,
			reason: "no-sw",
			// Firefox private browsing removes the property outright; so does a sandboxed
			// iframe without `allow-same-origin`, and some enterprise policies.
			detail: "navigator.serviceWorker is unavailable in this context",
		};
	}
	if (typeof isSecureContext === "boolean" && !isSecureContext) {
		return {
			sync: false,
			reason: "insecure-context",
			detail: "service workers require a secure context (https, or localhost)",
		};
	}
	return undefined;
}

/**
 * Check the arrangement that actually decides interception.
 *
 * Measured across Blink, Gecko and WebKit: a dedicated worker is controlled because **its own
 * script URL is inside the registration scope**, and whether the *page* is controlled does not
 * matter. So this is the one invariant worth asserting — and it must be asserted, because
 * violating it produces a hang rather than an error.
 */
function checkScope(
	reg: ServiceWorkerRegistration,
	workerURL: string
): NodeFsCapabilities | undefined {
	const worker = new URL(workerURL, location.href);
	if (worker.protocol === "blob:") {
		return {
			sync: false,
			reason: "blob-worker",
			detail:
				"a blob: worker URL is not matched against any scope, so its requests are not intercepted — serve worker.js from a real URL",
		};
	}
	const scope = new URL(reg.scope);
	if (
		worker.origin !== scope.origin ||
		!worker.pathname.startsWith(scope.pathname)
	) {
		return {
			sync: false,
			reason: "out-of-scope",
			detail:
				`the worker script ${worker.pathname} is outside the service worker scope ${scope.pathname}, ` +
				`so its synchronous filesystem requests will not be intercepted — serve sw.js from ` +
				`${new URL(".", worker).pathname} or widen the scope`,
		};
	}
	return undefined;
}

/**
 * Attach `sid` to the service worker so its frames reach `handle`.
 *
 * Re-attaches on its own whenever the worker asks (it was evicted and lost the registry) or the
 * controller changes (it was updated). Both are routine.
 */
export async function attachSession(
	sid: SessionId,
	handle: FrameHandler,
	opts: AttachOptions
): Promise<Attachment> {
	const unsupported = unsupportedReason();
	if (unsupported) throw new SyncFsUnavailable(unsupported);

	const reg = await registerOnce(opts.swURL, opts.swScope);
	const scopeProblem = checkScope(reg, opts.workerURL);
	if (scopeProblem) throw new SyncFsUnavailable(scopeProblem);

	let prefix: string | undefined;
	let closed = false;

	async function connect(): Promise<string> {
		const active = await activeOf(reg);
		const { port1, port2 } = new MessageChannel();
		const attached = new Promise<string>((resolve, reject) => {
			const deadline = setTimeout(
				() =>
					reject(new Error("service worker did not acknowledge the session")),
				5_000
			);
			port1.onmessage = (event: MessageEvent) => {
				const data = event.data as SwToPage | undefined;
				if (!data) return;
				if (data.t === "attached") {
					clearTimeout(deadline);
					if (data.proto !== WIRE_PROTO) {
						reject(
							new SyncFsUnavailable({
								sync: false,
								reason: "proto-mismatch",
								detail: `service worker speaks v${data.proto}, this build speaks v${WIRE_PROTO} — reload the page`,
							})
						);
						return;
					}
					prefix = new URL(data.prefix, location.href).href;
					resolve(prefix);
					return;
				}
				if (data.t === "op") {
					void answer(data.seq, data.frame, port1);
				}
			};
			port1.start?.();
		});
		// Through `registration.active`, never over a port already held: a `MessagePort` cannot
		// start a stopped service worker, and after an eviction nothing is listening on the old
		// port at all.
		active.postMessage({ t: "attach", sid, proto: WIRE_PROTO }, [port2]);
		return attached;
	}

	async function answer(seq: number, frame: ArrayBuffer, port: MessagePort) {
		// The heartbeat that makes `OP_TIMEOUT_MS` a *liveness* deadline rather than a limit
		// on how long an operation may take.
		//
		// Nothing sent one of these until now, so the service worker's 15 seconds was an
		// absolute ceiling on every synchronous op — including `proc.spawnSync`, whose own
		// contract promises a provider may take as long as it likes, and a blocking read at a
		// prompt, which waits exactly as long as the person at the keyboard does.
		const beat = setInterval(() => {
			try {
				port.postMessage({ t: "progress", seq });
			} catch {
				// The port died; the op's own answer will fail the same way.
			}
		}, PROGRESS_INTERVAL_MS);

		let out: Uint8Array;
		try {
			// Only the bytes. An op whose reply carries a handle cannot come this way at all —
			// an XHR body has nowhere to put one — which is why ../wire/kinds.ts declares those
			// ops async-only rather than leaving it to be discovered here.
			out = (await handle(frame)).frame;
		} catch (err) {
			// The router turns a failed *operation* into an in-band error and never rejects, so
			// reaching here means the handler itself broke. Answer with a message anyway: staying
			// silent leaves the worker parked until a deadline, which turns a bug on this side
			// into an unexplained timeout on the other.
			//
			// Built from the *message*, not from `seq`. `seq` here is the relay's own counter —
			// answering with it produced a reply the worker rejected as a crossed response, so
			// every dispatcher crash was reported as a transport fault instead of itself.
			console.error("[node-worker] dispatch failed", err);
			out = replyToBrokenFrame(frame, err);
		} finally {
			clearInterval(beat);
		}
		const buffer = out.buffer.slice(
			out.byteOffset,
			out.byteOffset + out.byteLength
		) as ArrayBuffer;
		try {
			port.postMessage({ t: "res", seq, frame: buffer }, [buffer]);
		} catch {
			// The port died between the request and the answer — the worker's own deadline covers
			// it.
		}
	}

	prefix = await connect();

	const onServiceWorkerMessage = (event: MessageEvent) => {
		const data = event.data as { t?: string; sid?: string } | undefined;
		if (closed || data?.t !== "rescue" || data.sid !== sid) return;
		void connect().catch((err) =>
			console.warn(
				"[node-worker] re-attach after service worker restart failed",
				err
			)
		);
	};
	navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);

	let channel: BroadcastChannel | undefined;
	try {
		channel = new BroadcastChannel(SW_BROADCAST_CHANNEL);
		channel.onmessage = onServiceWorkerMessage;
	} catch {
		// Not everywhere; the direct message above is the main path.
	}

	// A controller change means the worker was replaced, so the session is attached to
	// something that is gone.
	const onControllerChange = () => {
		if (closed) return;
		void connect().catch(() => {});
	};
	navigator.serviceWorker.addEventListener(
		"controllerchange",
		onControllerChange
	);

	// Tell the service worker to stop waiting on us the moment this page goes away, so a
	// request in flight fails immediately instead of sitting out the deadline.
	const onPageHide = () => {
		void reg.active?.postMessage({ t: "detach", sid });
	};
	addEventListener("pagehide", onPageHide);

	return {
		prefix,
		detach() {
			closed = true;
			navigator.serviceWorker.removeEventListener(
				"message",
				onServiceWorkerMessage
			);
			navigator.serviceWorker.removeEventListener(
				"controllerchange",
				onControllerChange
			);
			removeEventListener("pagehide", onPageHide);
			channel?.close();
			reg.active?.postMessage({ t: "detach", sid });
		},
	};
}

/**
 * Synchronous filesystem access is not available, and why.
 *
 * A dedicated error type because the consequence is severe and specific: the module resolver
 * is synchronous end to end, so without this transport there is no `require` and nothing runs.
 * Reporting it as a startup failure naming the cause beats every program failing to resolve its
 * first import.
 */
export class SyncFsUnavailable extends Error {
	readonly capabilities: NodeFsCapabilities;
	constructor(capabilities: NodeFsCapabilities) {
		super(
			`node-worker: synchronous filesystem unavailable (${capabilities.reason})` +
				(capabilities.detail ? `: ${capabilities.detail}` : "")
		);
		this.name = "SyncFsUnavailable";
		this.capabilities = capabilities;
	}
}

export { SW_PATH_SEGMENT };
