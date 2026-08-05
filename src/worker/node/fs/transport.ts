// The worker's two ways of reaching the host filesystem.
//
//   `vfsSync`  — a blocking XMLHttpRequest to a virtual URL a service worker intercepts and
//                relays to the page. This is what makes `fs.readFileSync` work.
//   `vfsAsync` — a postMessage round trip, for `fs.promises`.
//
// Both send the *same frame* to the *same dispatch table* (src/lib/vfs/dispatch.ts). The
// failure mode this boundary is most exposed to is a bug that exists on one transport and not
// the other, and there is nothing to diverge if there is only one implementation.
//
// Deliberately free of module-scope side effects and of any reference to `process`: this sits
// in the fs subgraph, which evaluates inside a module-init cycle (see ./lazy-base.ts), and
// anything imported this widely has to be safe to evaluate first.

import { fromWireError, toWireError } from "../../../vfs/errno";
import { decodeFrame, encodeFrame, FrameError } from "../../../vfs/wire";
import type {
	MountSnapshot,
	NodeFsCapabilities,
	VfsCall,
	VfsInit,
	VfsResult,
	WireReply,
} from "../../../vfs/wire";
import { SW_STATUS } from "../../../vfs/sw-wire";
import { under } from "../../../vfs/path";
import * as keepalive from "../../keepalive";
import { send } from "../../conn";

let CFG: VfsInit | undefined;
let capabilities: NodeFsCapabilities = {
	sync: false,
	reason: "probe-failed",
	detail: "the filesystem transport has not been initialized",
};
let seq = 1;

// ------------------------------------------------------------ the mount snapshot

/**
 * Seeded with a placeholder so a call arriving before `init` fails here, with a message that
 * says so, rather than somewhere confusing further down.
 */
let mounts: MountSnapshot[] = [
	{
		root: "/",
		name: "uninitialized",
		readOnly: false,
		createdMs: 0,
		hasNativeRange: false,
		canStream: false,
		hasCopyFile: false,
		hasStatfs: false,
	},
];

export function applyMountSnapshot(snapshot: MountSnapshot[]) {
	// Longest root first, so the first match is the most specific — the same ordering the
	// host's table uses, because both answer the same question.
	mounts = [...snapshot].sort((a, b) => b.root.length - a.root.length);
}

export function mountFor(path: string): MountSnapshot {
	for (const m of mounts) if (under(m.root, path)) return m;
	return mounts[mounts.length - 1];
}

export function listMountSnapshot(): readonly MountSnapshot[] {
	return mounts;
}

// ------------------------------------------------------------- reply side-effects
//
// A reply can carry watch events and resolver-cache invalidations caused by the very call being
// answered. They ride the reply rather than being pushed separately because that is the only
// delivery that works while this thread is parked inside a blocking request — a pushed message
// would sit in the queue until the XHR returned, long after the caller had moved on.
//
// Registered rather than imported so this module keeps no edge into `../../fsevents` or
// `../../module/resolve`, both of which sit in heavier parts of the graph.

type MetaSink = (meta: {
	events?: unknown[];
	invalidate?: { paths?: string[]; subtrees?: string[] };
	apiCalls?: Record<string, number>;
}) => void;

let metaSink: MetaSink | undefined;

export function onReplyMeta(sink: MetaSink) {
	metaSink = sink;
}

function applyMeta(reply: WireReply) {
	if (!metaSink) return;
	if (!reply.events && !reply.invalidate && !reply.apiCalls) return;
	try {
		metaSink({
			events: reply.events,
			invalidate: reply.invalidate,
			apiCalls: reply.apiCalls,
		});
	} catch {
		// A watcher or cache callback throwing must not fail the filesystem call that
		// happened to carry its notification.
	}
}

// -------------------------------------------------------------------- hop counters

let hops = new Map<string, number>();

function countHop(op: string, kind: "sync" | "async") {
	const key = `${op} ${kind}`;
	hops.set(key, (hops.get(key) ?? 0) + 1);
}

export function getHopStats(): Record<string, number> {
	return Object.fromEntries([...hops].sort((a, b) => b[1] - a[1]));
}

export function resetHopStats() {
	hops.clear();
}

// ------------------------------------------------------------------------- results

export interface VfsAnswer<K extends VfsCall["op"]> {
	value: VfsResult<K>;
	/** Views into the reply frame. Copy before keeping. */
	parts: Uint8Array[];
}

function unpack<K extends VfsCall["op"]>(
	bytes: ArrayBuffer | Uint8Array,
	call: VfsCall
): VfsAnswer<K> {
	const { header, parts } = decodeFrame<WireReply>(bytes);
	applyMeta(header);
	if (!header.result.ok) throw fromWireError(header.result.error);
	return { value: header.result.value as VfsResult<K>, parts };
}

/**
 * An `ArrayBuffer` exactly covering `u8`, without copying when it already does.
 *
 * Both transports need one — `xhr.send` and a `postMessage` transfer list — and `encodeFrame`
 * always allocates exactly, so the copy is normally skipped. The guard is there because a view
 * into a larger buffer would otherwise send the whole thing.
 */
function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
	if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
		return u8.buffer as ArrayBuffer;
	}
	return u8.slice().buffer as ArrayBuffer;
}

/**
 * A failure to *deliver*, as opposed to a filesystem answer of "no".
 *
 * Named so the retry above can tell them apart: an ENOENT must never be retried, and a service
 * worker that vanished mid-request must never be reported as an ENOENT.
 */
export class TransportError extends Error {
	readonly __nodeWorkerFsError = 1 as const;
	code = "EIO";
	errno = -5;
	constructor(message: string) {
		super(message);
		this.name = "Error";
	}
}

function transportError(message: string, cause?: unknown): Error {
	// EIO, so the `if (e.code !== "ENOENT") throw e` idiom above behaves, but with the real
	// cause in the message — a bare "i/o error" tells whoever is debugging nothing.
	return fromWireError(
		toWireError(Object.assign(new Error(message), { cause }), undefined)
	);
}

// ---------------------------------------------------------------- initialization

/**
 * Take the host's configuration and verify, once, that the synchronous transport genuinely
 * works.
 *
 * The probe is this design's safety valve. Every way interception can silently fail — a scope
 * that does not cover this worker, a policy that blocks synchronous XHR, a service worker that
 * never activated — produces a *hang* at the first `readFileSync` if it is not caught here.
 * One round trip at startup turns all of them into a legible startup state instead.
 */
export function initTransport(cfg: VfsInit): NodeFsCapabilities {
	CFG = cfg;
	applyMountSnapshot(cfg.mounts);

	if (!cfg.syncPrefix) {
		capabilities = {
			sync: false,
			reason: "no-sw",
			detail: "the host did not register a service worker",
		};
		return capabilities;
	}

	try {
		const answer = rawSync(seq++, { op: "probe" });
		const value = answer.value as { proto: number; sid: string };
		if (value?.sid !== cfg.sid) {
			capabilities = {
				sync: false,
				reason: "probe-failed",
				detail: `the filesystem answered for session ${value?.sid}, not ${cfg.sid}`,
			};
		} else if (value.proto !== cfg.proto) {
			capabilities = {
				sync: false,
				reason: "proto-mismatch",
				detail: `host speaks v${value.proto}, worker speaks v${cfg.proto}`,
			};
		} else {
			capabilities = { sync: true };
		}
	} catch (err) {
		const message = (err as Error)?.message ?? String(err);
		capabilities = {
			sync: false,
			// A DOMException from `send()` on a synchronous request is what a
			// `Permissions-Policy: sync-xhr=()` looks like — worth naming, because puter serves
			// apps in iframes and the whole filesystem depends on it.
			reason: /InvalidAccessError|not allowed|sync-xhr/i.test(message)
				? "sync-xhr-blocked"
				: "probe-failed",
			detail: message,
		};
	}
	return capabilities;
}

export function syncCapabilities(): NodeFsCapabilities {
	return capabilities;
}

// --------------------------------------------------------------- the transports

function rawSync<K extends VfsCall["op"]>(
	id: number,
	call: Extract<VfsCall, { op: K }>,
	parts?: Uint8Array[]
): VfsAnswer<K> {
	if (!CFG?.syncPrefix) {
		throw transportError(
			`ENOSYS: synchronous filesystem unavailable (${capabilities.reason}: ${capabilities.detail ?? "?"})`
		);
	}
	const frame = encodeFrame(
		{ seq: id, call, parts: parts?.map((p) => p.length) },
		parts
	);
	countHop(call.op, "sync");

	const xhr = new XMLHttpRequest();
	xhr.open(
		"POST",
		`${CFG.syncPrefix}v${CFG.proto}/${CFG.sid}/${id}-${call.op}`,
		false
	);
	xhr.responseType = "arraybuffer";
	// Legal here, illegal in a Window: the spec's `InvalidAccessError` for setting `timeout`,
	// `responseType` or `withCredentials` on a synchronous request applies only when the global
	// is a `Window`.
	//
	// Measured rather than assumed, though: Blink and Gecko honour it (a `TimeoutError` at the
	// deadline), and **WebKit accepts the setter and ignores it** — a stalled request there
	// runs until the service worker's own deadline answers 504. So this is defence-in-depth and
	// the SW-side deadline is the primary bound; do not weaken that one on the strength of this.
	if (CFG.timeoutMs > 0) {
		try {
			xhr.timeout = CFG.timeoutMs;
		} catch {
			// Some engine disagrees about where this is legal; the SW deadline still applies.
		}
	}

	try {
		xhr.send(asArrayBuffer(frame));
	} catch (err) {
		throw transportError(
			`synchronous filesystem request failed: ${(err as Error)?.message ?? err}`,
			err
		);
	}

	if (xhr.status !== SW_STATUS.ok) {
		// The body carries the reason for anything the service worker answered itself, and it is
		// plain text rather than a frame — decode it, because "answered 503" alone tells nobody
		// anything.
		let detail = "";
		try {
			const bytes = new Uint8Array(xhr.response ?? 0);
			if (bytes.length && bytes.length < 4096) {
				detail = ": " + new TextDecoder().decode(bytes);
			}
		} catch {
			// Not text; the status is all there is.
		}
		throw transportError(
			`synchronous filesystem request answered ${xhr.status}${detail}` +
				(xhr.status === SW_STATUS.noSession
					? " (no filesystem host attached — is the page still open?)"
					: xhr.status === SW_STATUS.timeout
						? " (the host did not answer in time)"
						: xhr.status === SW_STATUS.protoMismatch
							? " (service worker is a different build — reload the page)"
							: "")
		);
	}

	try {
		return unpack<K>(xhr.response, call);
	} catch (err) {
		// A frame that will not decode means the plumbing broke, not the filesystem — most
		// often a service worker that has been unregistered, in which case the XHR was answered
		// by the real server and this is somebody's 404 page.
		if (err instanceof FrameError) throw transportError(err.message, err);
		throw err;
	}
}

/**
 * How many times a *transport* failure is retried before giving up.
 *
 * A blocking request can fail with a network error — the service worker not answering, having
 * been evicted or restarted mid-flight — and the worker cannot tell whether the operation ran.
 * Retrying is only safe because the frame carries a `seq` and the host answers a repeat from its
 * reply record instead of re-executing, which makes the transport exactly-once. Without that,
 * a retried `append` would append twice.
 *
 * Only transport failures are retried. An operation that failed *in band* (ENOENT, EROFS) is an
 * answer, not a failure to deliver, and is returned as-is.
 */
const SYNC_RETRIES = 2;

/** One blocking round trip. The worker thread is parked for its whole duration. */
export function vfsSync<K extends VfsCall["op"]>(
	call: Extract<VfsCall, { op: K }>,
	parts?: Uint8Array[]
): VfsAnswer<K> {
	// The same seq across attempts — that is what makes the retry safe.
	const id = seq++;
	let last: unknown;
	for (let attempt = 0; attempt <= SYNC_RETRIES; attempt++) {
		try {
			return rawSync<K>(id, call, parts);
		} catch (err) {
			if (!(err instanceof TransportError)) throw err;
			last = err;
		}
	}
	throw last;
}

/** One asynchronous round trip, over the page channel. */
export async function vfsAsync<K extends VfsCall["op"]>(
	call: Extract<VfsCall, { op: K }>,
	parts?: Uint8Array[],
	signal?: AbortSignal
): Promise<VfsAnswer<K>> {
	signal?.throwIfAborted();
	const id = seq++;
	const frame = encodeFrame(
		{ seq: id, call, parts: parts?.map((p) => p.length), hasSignal: !!signal },
		parts
	);
	countHop(call.op, "async");

	// Every asynchronous filesystem operation is a live request as far as the event loop is
	// concerned, exactly as it is in libuv. Without this a program whose only pending work is
	// reading files is indistinguishable from one that has finished, and `drain` would let the
	// host tear it down mid-run.
	const release = keepalive.refOperation();
	try {
		const buffer = asArrayBuffer(frame);
		const reply = await send("vfs", { frame: buffer }, [buffer]);
		signal?.throwIfAborted();
		return unpack<K>(reply.frame, call);
	} finally {
		release();
	}
}

/**
 * A stream over a path, from the host.
 *
 * Outside the frame protocol on purpose — see the note on the protocol message. `release` is the
 * keepalive counterpart: an in-flight stream is a live handle as far as the event loop is
 * concerned, so a run whose only pending work is a stream must not be drained out from under it.
 * Idempotent, and the consumer MUST call it if it abandons the body.
 */
export async function openReadStream(
	path: string,
	range?: { start?: number; end?: number }
): Promise<{
	stream: ReadableStream<Uint8Array>;
	size?: number;
	release: () => void;
}> {
	return openStream({ path, start: range?.start, end: range?.end });
}

/** As above, over an open fd, so a handle's unflushed bytes are what gets streamed. */
export async function openReadStreamFd(
	fd: number,
	range?: { start?: number; end?: number }
): Promise<{
	stream: ReadableStream<Uint8Array>;
	size?: number;
	release: () => void;
}> {
	return openStream({ fd, start: range?.start, end: range?.end });
}

async function openStream(msg: {
	path?: string;
	fd?: number;
	start?: number;
	end?: number;
}): Promise<{
	stream: ReadableStream<Uint8Array>;
	size?: number;
	release: () => void;
}> {
	keepalive.ref();
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		keepalive.unref();
	};
	try {
		const reply = await send("vfs-open-read", msg);
		return { stream: reply.stream, size: reply.size, release };
	} catch (err) {
		release();
		throw err;
	}
}

/** Bytes out of an answer, copied so nothing holds a view into the reply frame. */
export function answerBytes(answer: VfsAnswer<any>): Uint8Array {
	const part = answer.parts[0];
	return part ? new Uint8Array(part) : new Uint8Array(0);
}
