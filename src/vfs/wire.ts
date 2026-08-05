// The filesystem wire protocol: one framing, one op set, two transports.
//
// A worker-side `fs` call becomes exactly one frame, answered by exactly one frame.
// The *same* frame goes over both transports — a blocking `XMLHttpRequest` through the
// service worker for `fs.readFileSync`, and a `postMessage` for `fs.promises.readFile`
// — and that is deliberate rather than incidental. The async path does not need
// framing at all (`structuredClone` handles a `Uint8Array` perfectly well), but using
// it means a framing or error-envelope bug cannot hide on one transport and not the
// other, which is the failure mode this whole boundary is most exposed to. It also
// makes the crossing zero-copy: one `ArrayBuffer`, transferred.

import type { FsEntry, Listing, ReaddirOpts, WireCtx } from "./entry";
import type { WireError } from "./errno";

/**
 * Bumped on any incompatible change to the framing or the op set.
 *
 * Carried in the frame *and* in the request URL, because a page and a service worker
 * can be different builds: a stale SW is a normal consequence of a redeploy, and the
 * skew has to be detectable before either side parses a body it may not understand.
 */
export const NODEFS_PROTO = 1;

/** The scope-relative path segment the service worker claims. */
export const SW_PATH_SEGMENT = "__nodefs";

// ------------------------------------------------------------------ the frame

/**
 * `"NFS1"`, as a little-endian u32 — so the first four bytes read as ASCII in a hex
 * dump.
 *
 * This field is the difference between a legible failure and a baffling one. When the
 * service worker has been unregistered, the blocking XHR is answered by the *real*
 * server: a 404 page, or the SPA's `index.html`. Without a magic number that HTML
 * reaches `JSON.parse` and surfaces as a `SyntaxError` from nowhere. With it, the
 * worker reports "not a node-worker fs frame (service worker gone?)".
 */
const FRAME_MAGIC = 0x3153464e;
const HEADER_OFFSET = 16;

/** Round up to the payload's alignment. */
function align8(n: number): number {
	return (n + 7) & ~7;
}

/** Thrown by {@link decodeFrame}. Distinguishable, because it means the plumbing broke. */
export class FrameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FrameError";
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * ```
 * off  size  field
 *  0    4    magic       "NFS1", little-endian
 *  4    2    proto       NODEFS_PROTO
 *  6    2    flags       reserved; 0
 *  8    4    headerLen   bytes of UTF-8 JSON
 * 12    4    payloadLen  sum of every part's length
 * 16    H    header      JSON
 *      pad   to an 8-byte boundary
 *           payload      the parts, concatenated
 * ```
 *
 * `payloadLen` is redundant with the header's `parts` array, and that is the point: a
 * body truncated in transit would otherwise produce a **silently short file**, which
 * is the worst failure mode a filesystem has. Checked against the actual byte length,
 * truncation is an error instead.
 *
 * The 8-byte payload alignment lets a part be viewed as any typed array without
 * copying it first.
 */
export function encodeFrame(
	header: object,
	parts?: readonly Uint8Array[]
): Uint8Array {
	const headerBytes = encoder.encode(JSON.stringify(header));
	const payloadStart = align8(HEADER_OFFSET + headerBytes.length);
	let payloadLen = 0;
	if (parts) for (const part of parts) payloadLen += part.length;

	const out = new Uint8Array(payloadStart + payloadLen);
	const view = new DataView(out.buffer);
	view.setUint32(0, FRAME_MAGIC, true);
	view.setUint16(4, NODEFS_PROTO, true);
	view.setUint16(6, 0, true);
	view.setUint32(8, headerBytes.length, true);
	view.setUint32(12, payloadLen, true);
	out.set(headerBytes, HEADER_OFFSET);

	let at = payloadStart;
	if (parts) {
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
	}
	return out;
}

export interface DecodedFrame<H> {
	header: H;
	parts: Uint8Array[];
}

/**
 * The inverse, with every check that distinguishes "the filesystem said no" from "the
 * bridge broke". The `parts` are **views** into `bytes`, not copies.
 */
export function decodeFrame<H>(
	bytes: ArrayBuffer | Uint8Array | null
): DecodedFrame<H> {
	if (!bytes) throw new FrameError("empty fs response");
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (u8.length < HEADER_OFFSET) {
		throw new FrameError(`fs response too short (${u8.length} bytes)`);
	}

	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (view.getUint32(0, true) !== FRAME_MAGIC) {
		throw new FrameError(
			"not a node-worker fs frame (service worker gone or unregistered?)"
		);
	}
	const proto = view.getUint16(4, true);
	if (proto !== NODEFS_PROTO) {
		throw new FrameError(
			`fs protocol mismatch: frame is v${proto}, this build speaks v${NODEFS_PROTO} — reload the page`
		);
	}

	const headerLen = view.getUint32(8, true);
	const payloadLen = view.getUint32(12, true);
	const payloadStart = align8(HEADER_OFFSET + headerLen);
	if (payloadStart + payloadLen !== u8.length) {
		throw new FrameError(
			`truncated fs frame: expected ${payloadStart + payloadLen} bytes, got ${u8.length}`
		);
	}

	let header: H;
	try {
		header = JSON.parse(
			decoder.decode(u8.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLen))
		);
	} catch (err) {
		throw new FrameError(
			`malformed fs frame header: ${(err as Error).message}`
		);
	}

	const lengths =
		(header as { parts?: number[] })?.parts ?? (payloadLen ? [payloadLen] : []);
	const parts: Uint8Array[] = [];
	let at = payloadStart;
	for (const length of lengths) {
		parts.push(u8.subarray(at, at + length));
		at += length;
	}
	if (at !== u8.length) {
		throw new FrameError(
			`fs frame parts do not cover the payload: ${at - payloadStart} of ${payloadLen} bytes`
		);
	}

	return { header, parts };
}

// -------------------------------------------------------------------- the ops

/**
 * One filesystem operation.
 *
 * Note what is *not* a primitive here. `exists`, `access`, `append`, `truncate`,
 * `mkdtemp`, `cp`, `rmrf` and `mkdirp` are compositions — the worker used to build
 * them out of several provider calls, which cost several round trips each. They are
 * single ops now because the host owns the whole filesystem and can compose them
 * locally, which is what keeps every `fs.*Sync` call to exactly one blocking request.
 *
 * `cp` deliberately carries no `filter`: it is a user callback living in the worker,
 * so a filtered copy stays a worker-driven walk.
 */
export type VfsCall =
	/** Verifies end-to-end interception at startup. See `NodeFsCapabilities`. */
	| { op: "probe" }
	| { op: "mounts" }
	| { op: "stat"; ctx: WireCtx; path: string }
	| { op: "access"; ctx: WireCtx; path: string }
	| { op: "exists"; ctx: WireCtx; path: string }
	| { op: "statfs"; ctx: WireCtx; path: string }
	| { op: "readdir"; ctx: WireCtx; path: string; opts?: ReaddirOpts }
	| { op: "readFile"; ctx: WireCtx; path: string }
	| {
			op: "readRange";
			ctx: WireCtx;
			path: string;
			offset: number;
			length: number;
	  }
	/** Bytes in `parts[0]`. */
	| { op: "writeFile"; ctx: WireCtx; path: string }
	/** Bytes in `parts[0]`. */
	| { op: "append"; ctx: WireCtx; path: string }
	| { op: "mkdir"; ctx: WireCtx; path: string; recursive: boolean }
	| { op: "rm"; ctx: WireCtx; path: string; recursive: boolean; force: boolean }
	| { op: "rmrf"; ctx: WireCtx; path: string; force: boolean }
	| { op: "rename"; ctx: WireCtx; from: string; to: string }
	| {
			op: "copyFile";
			ctx: WireCtx;
			from: string;
			to: string;
			overwrite: boolean;
	  }
	| {
			op: "utimes";
			ctx: WireCtx;
			path: string;
			atimeMs: number;
			mtimeMs: number;
	  }
	| { op: "truncate"; ctx: WireCtx; path: string; length: number }
	| { op: "mkdtemp"; ctx: WireCtx; prefix: string }
	| {
			op: "cp";
			ctx: WireCtx;
			from: string;
			to: string;
			recursive: boolean;
			force: boolean;
			errorOnExist: boolean;
	  }
	| VfsFdCall;
/**
 * The fd family.
 *
 * These exist because the handle — the fd table, the whole-file buffer, the append cursor, the
 * byte-range cache — lives next to the providers rather than in the worker. That is what makes
 * every `fs.*Sync` call exactly one blocking round trip: `writeSync` used to be three (stat,
 * readFile, writeFile) and `readvSync`/`writevSync` were one per buffer.
 *
 * It also keeps the buffer on the same side as the backend, so an `appendFileSync` in a loop
 * ships only the delta instead of pulling the whole file into the worker each time.
 */
export type VfsFdCall =
	/** `flags` is normalized but not parsed: a canonical string, or an O_* bitmask. */
	| { op: "open"; ctx: WireCtx; path: string; flags: string | number }
	| { op: "close"; ctx: WireCtx; fd: number }
	| {
			op: "fdRead";
			ctx: WireCtx;
			fd: number;
			length: number;
			position: number | null;
	  }
	| {
			op: "fdReadv";
			ctx: WireCtx;
			fd: number;
			lengths: number[];
			position: number | null;
	  }
	/** Bytes in `parts[0]`. */
	| { op: "fdWrite"; ctx: WireCtx; fd: number; position: number | null }
	/** One part per buffer. */
	| { op: "fdWritev"; ctx: WireCtx; fd: number; position: number | null }
	| { op: "fdReadFile"; ctx: WireCtx; fd: number }
	/** Bytes in `parts[0]`. */
	| { op: "fdWriteFile"; ctx: WireCtx; fd: number }
	/** Bytes in `parts[0]`. */
	| { op: "fdAppend"; ctx: WireCtx; fd: number }
	| { op: "fdStat"; ctx: WireCtx; fd: number }
	| { op: "fdTruncate"; ctx: WireCtx; fd: number; length: number }
	| { op: "fdSync"; ctx: WireCtx; fd: number }
	| {
			op: "fdUtimes";
			ctx: WireCtx;
			fd: number;
			atimeMs: number;
			mtimeMs: number;
	  }
	/**
	 * write + sync + close, as one op.
	 *
	 * `Utf8Stream.flushSync` did exactly that sequence and paid five blocking round trips for
	 * it; a logger flushing per line felt every one.
	 */
	| { op: "fdFlushWrite"; ctx: WireCtx; fd: number };

export type VfsOpName = VfsCall["op"];

/** What each op answers. Ops that return bytes carry them in `parts`, not here. */
export interface VfsResults {
	probe: { proto: number; sid: string };
	mounts: MountSnapshot[];
	stat: FsEntry;
	access: null;
	exists: boolean;
	statfs: { used: number; capacity: number };
	readdir: Listing;
	readFile: null;
	readRange: null;
	writeFile: null;
	append: null;
	mkdir: string | undefined;
	rm: null;
	rmrf: null;
	rename: null;
	copyFile: null;
	utimes: boolean;
	truncate: null;
	mkdtemp: string;
	cp: null;

	// the fd family
	open: { fd: number };
	close: null;
	/** Bytes in `parts[0]`; the count is that part's length. */
	fdRead: null;
	/** One part per requested length, truncated at the first short read. */
	fdReadv: null;
	fdWrite: number;
	fdWritev: number;
	fdReadFile: null;
	fdWriteFile: null;
	fdAppend: null;
	fdStat: FsEntry;
	fdTruncate: null;
	fdSync: null;
	fdUtimes: boolean;
	fdFlushWrite: null;
}

export type VfsResult<K extends VfsOpName> = VfsResults[K];

// ------------------------------------------------------------------ the reply

/**
 * The header of an answering frame.
 *
 * `events` and `invalidate` are piggybacked rather than pushed separately, and both
 * are load-bearing.
 *
 * `events` replaces what the providers used to do directly: they called
 * `emitLocalFsEvent` in the worker the moment a mutation succeeded, which is what
 * makes write-then-observe (chokidar's `awaitWriteFinish`, a dev server's HMR trigger)
 * feel immediate. Riding the reply keeps that timing *and* works while the worker is
 * blocked inside a synchronous call, because the event arrives on the response the
 * worker is already waiting for.
 *
 * `invalidate` replaces the direct calls into the module resolver's caches. Those
 * caches are deliberately never invalidated otherwise, so a file the *host* wrote
 * would be answered as "missing" forever — a bug that only shows up on a second run.
 */
export interface WireReply {
	/** Echo of the request's sequence number. A mismatch is a routing bug, never a slow answer. */
	seq: number;
	result: { ok: true; value: unknown } | { ok: false; error: WireError };
	/** Byte length of each part, in order. */
	parts?: number[];
	events?: unknown[];
	invalidate?: { paths?: string[]; subtrees?: string[] };
	/** Per-endpoint backend call counts, for `NODE_WORKER_API_STATS`. */
	apiCalls?: Record<string, number>;
}

export interface WireRequest {
	seq: number;
	call: VfsCall;
	parts?: number[];
	/** Whether the caller passed an `AbortSignal`, so the host arms a controller for this `seq`. */
	hasSignal?: boolean;
}

// ------------------------------------------------------- mounts and capabilities

/**
 * What the worker is told about a mount.
 *
 * Only what it can act on locally. `hasNativeRange` is the one that has to be honest
 * in both directions: a derived ranged read slices a whole-file read, so claiming a
 * native range that isn't one makes a positioned-read loop re-read the entire file per
 * chunk, while under-claiming merely buffers the file once.
 */
export interface MountSnapshot {
	root: string;
	/** Provider name; diagnostics only. */
	name: string;
	readOnly: boolean;
	createdMs: number;
	hasNativeRange: boolean;
	canStream: boolean;
	hasCopyFile: boolean;
	hasStatfs: boolean;
}

/**
 * Whether the synchronous transport actually works, and if not, why.
 *
 * A `reason` rather than a bare boolean because the failures are unrelated and the fix
 * differs for each — and because the alternative is reporting them all as `EIO`, which
 * is indistinguishable from a genuine I/O failure and sends people hunting the wrong
 * bug. Note that without sync fs there is no module resolution at all (the resolver is
 * synchronous end to end), so this is normally a startup error rather than a degraded
 * mode.
 */
export interface NodeFsCapabilities {
	sync: boolean;
	reason?:
		| "no-sw"
		| "insecure-context"
		| "sync-xhr-blocked"
		| "out-of-scope"
		| "blob-worker"
		| "proto-mismatch"
		| "probe-failed";
	/** Human-readable detail for the reason, when there is any. */
	detail?: string;
}

/** Everything the worker needs to reach the host filesystem, delivered with `init`. */
export interface VfsInit {
	/** Identifies this worker's session to the service worker and the host. */
	sid: string;
	proto: number;
	/**
	 * Absolute URL prefix the worker POSTs a frame to, derived by the page from the
	 * service worker's registration scope — never guessed by the worker. Absent when
	 * there is no service worker, which means no synchronous filesystem.
	 */
	syncPrefix?: string;
	/** ms a blocked synchronous op may wait before giving up with EIO. 0 disables. */
	timeoutMs: number;
	mounts: MountSnapshot[];
}
