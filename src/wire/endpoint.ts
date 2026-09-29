// One end of the message port, in either direction.
//
// Both sides need the same four things: mint a sequence number, park a caller on a reply,
// route what arrives, and fail everything outstanding when the other end goes away. That
// used to be written out twice — `src/worker/conn.ts` and the top of `src/lib/index.ts`
// were the same ninety lines with the identifiers changed, down to the comment explaining
// why errors are packed rather than posted — and the two had already drifted: one dropped
// an unmatched reply silently, the other threw "unreachable!!" at an unregistered type,
// and neither ever timed out or cleaned up after a peer that vanished.
//
// It is one class now, and correlation is the message's own `seq` rather than a uid minted
// alongside it. Each side counts its own requests; a message carrying `call` is a request
// to route, and one carrying `result` is a reply to settle. The two spaces never collide
// because a side only ever looks up seqs it issued itself.

import { decodeFrame } from "./frame";
import { safe } from "./safe";
import { OutboundQueue, packRequest } from "./pack";
import { Router } from "./router";
import type { PortEnvelope, WireReply } from "./message";
import type { DecodedFrame } from "./frame";

/** How an envelope actually leaves. Normally the port; the bootstrap is the exception. */
type Poster = (envelope: PortEnvelope, transfer: Transferable[]) => void;

export interface CallOptions {
	parts?: readonly Uint8Array[];
	/** Handles to hand over with the request. Makes the call async-only. */
	transfer?: Transferable[];
	/**
	 * Values to **clone** alongside the request rather than hand over.
	 *
	 * `parts` carries bytes and the header carries JSON, which between them cover everything
	 * except the one thing structured clone is for: a `Map`, a `Date`, a typed array, a nested
	 * object graph. `worker_threads`' `workerData` is exactly that, and JSON would quietly
	 * flatten it.
	 *
	 * Distinct from `transfer` because a transfer list may hold only `Transferable`s — putting a
	 * plain object in one throws `DataCloneError`. These are appended *after* the transfers in
	 * `attachments`, so a reader that expects a handle at `[0]` keeps working. Async-only, for
	 * the same reason `transfer` is: an XHR body has nowhere to put them.
	 */
	attach?: unknown[];
}

/** A settled reply, still encoded — the caller decides what its value means. */
export interface Settled {
	decoded: DecodedFrame<WireReply>;
	attachments: readonly unknown[];
}

/**
 * An `ArrayBuffer` exactly covering `u8`, without copying when it already does.
 *
 * `encodeFrame` always allocates exactly, so the copy is normally skipped. The guard is
 * there because a view into a larger buffer would otherwise transfer the whole thing.
 */
export function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
	return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
		? (u8.buffer as ArrayBuffer)
		: (safe.arrayBufferSlice(u8.buffer,
				u8.byteOffset,
				u8.byteOffset + u8.byteLength
			) as ArrayBuffer);
}

export class PortEndpoint {
	readonly router = new Router();
	/**
	 * Messages waiting for something to ride on.
	 *
	 * Drained into every request this side sends, whichever transport carries it — which is
	 * what makes buffered stdout free: it goes out with the next `readFileSync` rather than
	 * paying for a round trip of its own, and it is *ahead* of that call in the same
	 * message, so the terminal cannot see the two out of order.
	 */
	readonly outbound = new OutboundQueue();
	#port: MessagePort | undefined;
	#seq = 1;
	#inflight = new safe.Map<
		number,
		{ resolve: (settled: Settled) => void; reject: (err: unknown) => void }
	>();
	#closed: unknown;

	/** Whether there is a port to send on at all. */
	get attached(): boolean {
		return !!this.#port;
	}

	attach(port: MessagePort): void {
		this.#port = port;
		port.onmessage = (e: MessageEvent) => this.#receive(e);
		safe.messagePortStart(port);
	}

	/** The next sequence number this side will use. Exposed for the sync transport. */
	nextSeq(): number {
		return this.#seq++;
	}

	/**
	 * Send a request and wait for its reply.
	 *
	 * `seq` is minted here so that the sync and async transports share one counter — the
	 * host's replay record is keyed on it, and two counters would let a retry over one
	 * transport be answered from the other's record.
	 */
	call(kind: number, call: unknown, opts: CallOptions = {}): Promise<Settled> {
		const seq = this.#seq++;
		return this.callWithSeq(seq, kind, call, opts);
	}

	callWithSeq(
		seq: number,
		kind: number,
		call: unknown,
		opts: CallOptions = {},
		via?: Poster
	): Promise<Settled> {
		return new safe.Promise<Settled>((resolve, reject) => {
			if (this.#closed) {
				reject(this.#closed);
				return;
			}
			const post = via ?? this.#poster();
			if (!post) {
				reject(new safe.Error("wire: no message port attached"));
				return;
			}
			const bytes = packRequest(
				kind,
				seq,
				call,
				opts.parts,
				this.outbound.drain()
			);
			const frame = asArrayBuffer(bytes);
			safe.mapSet(this.#inflight, seq, { resolve, reject });
			const envelope: PortEnvelope = { f: frame };
			// Transfers first so `attachments[0]` is still the handle every existing reader
			// expects; clones after.
			if (opts.transfer?.length || opts.attach?.length) {
				const attached: unknown[] = [];
				for (let i = 0; i < (opts.transfer?.length ?? 0); i++) safe.arrayPush(attached, opts.transfer![i]);
				for (let i = 0; i < (opts.attach?.length ?? 0); i++) safe.arrayPush(attached, opts.attach![i]);
				envelope.a = attached;
			}
			try {
				const transfer: Transferable[] = [frame];
				for (let i = 0; i < (opts.transfer?.length ?? 0); i++) safe.arrayPush(transfer, opts.transfer![i]);
				post(envelope, transfer);
			} catch (err) {
				safe.mapDelete(this.#inflight, seq);
				reject(err);
			}
		});
	}

	#poster(): Poster | undefined {
		const port = this.#port;
		if (!port) return undefined;
		return (envelope, transfer) => safe.messagePortPost(port, envelope, transfer);
	}

	/**
	 * The one call that cannot go over the port, because it is what delivers the port.
	 *
	 * Sent over the target's own `postMessage` with the port as its first attachment. The
	 * *reply* comes back over that port like every other, so this is a bootstrap only in
	 * how it leaves — attach first, then send, or the answer arrives at a port nobody is
	 * listening on.
	 */
	bootstrap(
		target: {
			postMessage(message: unknown, transfer: Transferable[]): void;
		},
		kind: number,
		call: unknown,
		transfer: Transferable[]
	): Promise<Settled> {
		return this.callWithSeq(
			this.#seq++,
			kind,
			call,
			{ transfer },
			(envelope, list) => target.postMessage(envelope, list)
		);
	}

	/**
	 * Send without waiting for an answer.
	 *
	 * For a notification whose reply carries nothing worth having — buffered output on its
	 * way out, `ctl.exit` from a worker that is about to be terminated. The far side still
	 * answers; the reply simply finds no waiter and is dropped.
	 */
	post(kind: number, call: unknown, opts: CallOptions = {}): void {
		const port = this.#port;
		if (!port || this.#closed) return;
		const bytes = packRequest(
			kind,
			this.#seq++,
			call,
			opts.parts,
			this.outbound.drain()
		);
		const frame = asArrayBuffer(bytes);
		const envelope: PortEnvelope = { f: frame };
		if (opts.transfer?.length) envelope.a = opts.transfer;
		try {
			const transfer: Transferable[] = [frame];
			for (let i = 0; i < (opts.transfer?.length ?? 0); i++) safe.arrayPush(transfer, opts.transfer![i]);
			safe.messagePortPost(port, envelope, transfer);
		} catch {
			// Nothing is waiting on this by construction, so a dead port is not an error to
			// report — it is the ordinary end of a worker that is going away.
		}
	}

	#receive(e: MessageEvent): void {
		const envelope = e.data as PortEnvelope | undefined;
		if (!envelope?.f) return;
		const attachments = envelope.a ?? [];

		let decoded: DecodedFrame<WireReply & { call?: unknown }>;
		try {
			decoded = decodeFrame(envelope.f);
		} catch (err) {
			// Undecodable bytes are not one caller's problem: the channel is carrying garbage
			// and every request on it is unanswerable. Failing them all reports that, where
			// dropping the message parks each one until its own deadline with no reason given.
			this.close(err);
			return;
		}

		// A request carries `call`; a reply carries `result`. Nothing else distinguishes
		// them, and nothing else needs to — a side only looks up seqs it issued itself, so
		// the two directions cannot collide however they number their own.
		if (decoded.header.call !== undefined) {
			void this.#answer(envelope.f, attachments);
			return;
		}

		const waiter = safe.mapGet(this.#inflight, decoded.header.seq);
		if (!waiter) return;
		safe.mapDelete(this.#inflight, decoded.header.seq);
		waiter.resolve({ decoded, attachments });
	}

	/**
	 * Route one message and post its answer.
	 *
	 * Public because the bootstrap message arrives before there is a port to receive it on
	 * — it is what carries the port — and must still be answered the same way as every
	 * message after it.
	 */
	async deliver(
		frame: ArrayBuffer,
		attachments: readonly unknown[] = []
	): Promise<void> {
		return this.#answer(frame, attachments);
	}

	async #answer(
		frame: ArrayBuffer,
		attachments: readonly unknown[]
	): Promise<void> {
		const out = await this.router.handle(frame, attachments);
		const port = this.#port;
		if (!port) return;
		const buffer = asArrayBuffer(out.frame);
		const envelope: PortEnvelope = { f: buffer };
		if (out.transfer?.length) envelope.a = out.transfer;
		try {
			const transfer: Transferable[] = [buffer];
			for (let i = 0; i < (out.transfer?.length ?? 0); i++) safe.arrayPush(transfer, out.transfer![i]);
			safe.messagePortPost(port, envelope, transfer);
		} catch {
			// The port closed between the request and the answer. Whoever asked is going away
			// too, and its own deadline covers anything still parked.
		}
	}

	/**
	 * Fail everything outstanding and stop sending.
	 *
	 * Called on teardown and on a channel that has started delivering nonsense. Neither
	 * side did this before, so a terminated worker left its own callers parked forever on
	 * promises nothing would ever settle.
	 */
	close(reason?: unknown): void {
		this.#closed =
			reason ??
			new safe.Error("wire: the message port closed while calls were pending");
		const outstanding: { reject: (err: unknown) => void }[] = [];
		safe.mapForEach(this.#inflight, (waiter: { reject: (err: unknown) => void }) => safe.arrayPush(outstanding, waiter));
		safe.mapClear(this.#inflight);
		for (let i = 0; i < outstanding.length; i++) outstanding[i].reject(this.#closed);
		try {
			if (this.#port) safe.messagePortClose(this.#port);
		} catch {
			// Already gone.
		}
		this.#port = undefined;
	}
}
