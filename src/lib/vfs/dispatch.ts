// Frame in, frame out. The one entry point both transports call.
//
// The synchronous path (a blocking XHR relayed by the service worker) and the asynchronous
// path (a postMessage) both land here, on the same bytes, through the same dispatch table.
// That is deliberate: the failure mode this boundary is most exposed to is a bug that
// exists on one transport and not the other, and there is nothing to diverge if there is
// only one implementation.
//
// It is also the seam that keeps the host VFS movable. Nothing here knows whether the caller
// is a service worker, a window, or a dedicated worker the page owns — so relaying frames to
// a VFS host worker later (which is where OPFS is fastest, since `createSyncAccessHandle` is
// worker-only) is a change to the plumbing above, not to this file.

import { toWireError } from "../../vfs/errno";
import { decodeFrame, encodeFrame } from "../../vfs/wire";
import type { PuterFsEvent } from "../../protocol";
import type { VfsCall, WireReply, WireRequest } from "../../vfs/wire";
import { parseOpenFlags } from "../../vfs/flags";
import type { MountTable } from "./mounts";
import type { Facade } from "./facade";
import type { HandleRegistry } from "./handles";
import * as ops from "./ops";

export interface DispatchDeps {
	fs: Facade;
	table: MountTable;
	/** Open files. Lives here rather than in the worker; see ./handles.ts. */
	handles: HandleRegistry;
	sid: string;
	proto: number;
	/**
	 * Watch events produced *by this call*, drained into its reply.
	 *
	 * They ride the reply rather than being pushed separately for two reasons: it preserves
	 * the "emitted the moment the call succeeded" timing that makes write-then-observe feel
	 * immediate, and — the load-bearing half — it works while the worker is parked inside a
	 * synchronous call, because the event arrives on the response the worker is already
	 * waiting for. A pushed event would sit in the worker's message queue until the blocking
	 * XHR returned.
	 */
	drainEvents(): PuterFsEvent[];
	/** Resolver-cache invalidations this call implies. See ./virtual.ts. */
	drainInvalidations(): { paths?: string[]; subtrees?: string[] } | undefined;
	/** Backend call counts to report back, when the worker asked for them. */
	drainApiCalls?(): Record<string, number> | undefined;
	/** Per-`seq` abort controllers, armed when the caller passed a signal. */
	controllers?: Map<number, AbortController>;
	/** This session's reply record, for the exactly-once retry. See `createReplayCache`. */
	replies: Map<number, Uint8Array>;
}

/** The result of one op: a value for the header, and any bytes for the payload. */
type Answer = { value: unknown; parts?: Uint8Array[] };

/**
 * Replies kept so a repeated `seq` is answered rather than re-executed.
 *
 * The transport underneath is at-least-once: a blocking request can fail with a network error
 * having reached the host, or having not reached it, and the worker cannot tell which. Retrying
 * blindly would be wrong — a second `append` appends twice — so the worker retries the *same*
 * `seq` and this turns that into exactly-once.
 *
 * **Per session, not global.** Sequence numbers are minted per worker and start from 1, so a
 * shared record would let one session be answered with another's reply — which the host test
 * suite caught immediately, since every test starts a fresh `NodeVfs` and every one of them
 * begins at seq 1.
 *
 * Bounded, and small on purpose: it only has to cover an immediate retry, not history.
 */
const REPLAY_WINDOW = 64;

export function createReplayCache(): Map<number, Uint8Array> {
	return new Map();
}

function remember(cache: Map<number, Uint8Array>, seq: number, frame: Uint8Array) {
	cache.set(seq, frame);
	// Insertion-ordered, so the oldest key is the first one.
	for (const key of cache.keys()) {
		if (cache.size <= REPLAY_WINDOW) break;
		cache.delete(key);
	}
}

export async function handleFrame(
	deps: DispatchDeps,
	frame: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
	let request: WireRequest;
	let parts: Uint8Array[];
	try {
		const decoded = decodeFrame<WireRequest>(frame);
		request = decoded.header;
		parts = decoded.parts;
	} catch (err) {
		// A frame we cannot even parse has no seq to echo. Answer with one anyway so the
		// worker gets a node-shaped error rather than a decode failure of its own.
		return reply({
			seq: 0,
			result: { ok: false, error: toWireError(err, "read") },
		});
	}

	const seq = request.seq;

	// A repeat means the worker retried after a transport failure. Answer from the record rather
	// than running the operation again — the whole point of the retry being safe.
	const already = deps.replies.get(seq);
	if (already) return already;

	let answer: Answer;
	try {
		answer = await perform(deps, request.call, parts);
	} catch (err) {
		const failed = reply(
			{
				seq,
				result: {
					ok: false,
					error: toWireError(err, ctxOf(request.call)?.syscall),
				},
			},
			deps
		);
		remember(deps.replies, seq, failed);
		return failed;
	}

	const ok = reply(
		{ seq, result: { ok: true, value: answer.value } },
		deps,
		answer.parts
	);
	remember(deps.replies, seq, ok);
	return ok;
}

function ctxOf(
	call: VfsCall
): { syscall: string; reportPath: string } | undefined {
	return "ctx" in call ? call.ctx : undefined;
}

function reply(
	body: WireReply,
	deps?: DispatchDeps,
	parts?: Uint8Array[]
): Uint8Array {
	if (deps) {
		const events = deps.drainEvents();
		if (events.length) body.events = events;
		const invalidate = deps.drainInvalidations();
		if (invalidate) body.invalidate = invalidate;
		const apiCalls = deps.drainApiCalls?.();
		if (apiCalls && Object.keys(apiCalls).length) body.apiCalls = apiCalls;
	}
	if (parts && parts.length) body.parts = parts.map((p) => p.length);
	return encodeFrame(body, parts);
}

/** No bytes, just a value. */
const v = (value: unknown): Answer => ({ value });
/** Bytes in the payload; the header's value is null. */
const b = (bytes: Uint8Array): Answer => ({ value: null, parts: [bytes] });

async function perform(
	deps: DispatchDeps,
	call: VfsCall,
	parts: Uint8Array[]
): Promise<Answer> {
	const { fs } = deps;
	switch (call.op) {
		// Answered without touching the filesystem: this is the startup probe that verifies
		// the service worker is really intercepting, and it echoes the session id back so a
		// misrouted request is caught rather than silently served.
		case "probe":
			return v({ proto: deps.proto, sid: deps.sid });
		case "mounts":
			return v(deps.table.snapshot());

		case "stat":
			return v(await fs.stat(call.ctx, call.path));
		case "access":
			return v((await fs.stat(call.ctx, call.path), null));
		case "exists":
			return v(await ops.exists(fs, call.ctx, call.path));
		case "statfs":
			return v(await fs.statfs(call.ctx, call.path));
		case "readdir":
			return v(await fs.readdir(call.ctx, call.path, call.opts));
		case "readFile":
			return b(await fs.readFile(call.ctx, call.path));
		case "readRange":
			return b(
				await fs.readRange(call.ctx, call.path, call.offset, call.length)
			);
		case "writeFile":
			await fs.writeFile(call.ctx, call.path, payload(parts));
			return v(null);
		case "append":
			await ops.append(fs, call.ctx, call.path, payload(parts));
			return v(null);
		case "mkdir":
			return v(
				await fs.mkdir(call.ctx, call.path, { recursive: call.recursive })
			);
		case "rm":
			await fs.rm(call.ctx, call.path, {
				recursive: call.recursive,
				force: call.force,
			});
			return v(null);
		case "rmrf":
			await ops.rmrf(fs, call.ctx, call.path, call.force);
			return v(null);
		case "rename":
			await fs.rename(call.ctx, call.from, call.to);
			return v(null);
		case "copyFile":
			await fs.copyFile(call.ctx, call.from, call.to, {
				overwrite: call.overwrite,
			});
			return v(null);
		case "utimes":
			return v(
				await ops.utimes(fs, call.ctx, call.path, call.atimeMs, call.mtimeMs)
			);
		case "truncate":
			await ops.truncate(fs, call.ctx, call.path, call.length);
			return v(null);
		case "mkdtemp":
			return v(await ops.mkdtemp(fs, call.ctx, call.prefix));
		case "cp":
			await ops.cp(fs, call.ctx, call.from, call.to, {
				recursive: call.recursive,
				force: call.force,
				errorOnExist: call.errorOnExist,
			});
			return v(null);

		// ------------------------------------------------------------ the fd family
		case "open": {
			// The read strategy is fixed for the fd's lifetime from the mount's capability,
			// which is why this is resolved here rather than guessed by the handle.
			const mount = deps.table.resolve(call.path).mount;
			const { fd } = await deps.handles.open(
				call.path,
				parseOpenFlags(call.flags),
				!!mount.provider.readRange
			);
			return v({ fd });
		}
		case "close":
			await deps.handles.close(call.fd);
			return v(null);
		case "fdRead":
			return b(
				await deps.handles.get(call.fd, "read").read(call.length, call.position)
			);
		case "fdReadv": {
			const chunks = await deps.handles
				.get(call.fd, "readv")
				.readv(call.lengths, call.position);
			return { value: null, parts: chunks };
		}
		case "fdWrite":
			return v(
				await deps.handles
					.get(call.fd, "write")
					.write(payload(parts), call.position)
			);
		case "fdWritev":
			return v(
				await deps.handles.get(call.fd, "writev").writev(parts, call.position)
			);
		case "fdReadFile":
			return b(await deps.handles.get(call.fd, "read").readFile());
		case "fdWriteFile":
			await deps.handles.get(call.fd, "write").writeFile(payload(parts));
			return v(null);
		case "fdAppend":
			await deps.handles.get(call.fd, "write").appendFile(payload(parts));
			return v(null);
		case "fdStat":
			return v(await deps.handles.get(call.fd, "fstat").stat());
		case "fdTruncate":
			await deps.handles.get(call.fd, "ftruncate").truncate(call.length);
			return v(null);
		case "fdSync":
			await deps.handles.get(call.fd, "fsync").sync();
			return v(null);
		case "fdUtimes":
			return v(
				await deps.handles
					.get(call.fd, "futimes")
					.utimes(call.atimeMs, call.mtimeMs)
			);
		case "fdFlushWrite": {
			// write + sync + close as one op, which is what `Utf8Stream.flushSync` wants and
			// what used to cost it five blocking round trips.
			const handle = deps.handles.get(call.fd, "write");
			if (parts.length) await handle.write(payload(parts), null);
			await handle.sync();
			await deps.handles.close(call.fd);
			return v(null);
		}
	}
	// Exhaustive over VfsCall; a new op that forgets a branch fails to compile.
	const never: never = call;
	throw new Error(`unknown vfs op: ${JSON.stringify(never)}`);
}

function payload(parts: Uint8Array[]): Uint8Array {
	return parts[0] ?? new Uint8Array(0);
}
