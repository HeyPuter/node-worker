// The two drivers that perform a `Plan`'s requests.
//
// `runSync` uses the blocking XMLHttpRequest transport, `runAsync` uses `fetch`.
// Everything else about an operation — which requests, in what order, how to read
// the responses, what counts as an error — lives in the plan, so these stay small
// and a third driver (a test double answering from fixtures, a batching driver)
// is a dozen lines.

import * as keepalive from "../../keepalive";
import { decode, fetchPuter, fetchPuterSync } from "../../puter";
import type { FsRequest, FsResponse, Plan } from "./plan";

/**
 * Wraps a completed round trip. `json()` decodes on first call and remembers the
 * result — including remembering that it failed, so a non-JSON body costs one
 * failed parse rather than one per access.
 */
export function makeResponse(
	ok: boolean,
	status: number,
	bytes: Uint8Array
): FsResponse {
	let decoded: any;
	let tried = false;
	return {
		ok,
		status,
		bytes,
		json() {
			if (!tried) {
				tried = true;
				try {
					decoded = decode(bytes);
				} catch {
					decoded = undefined;
				}
			}
			return decoded;
		},
	};
}

// Transport errors are delivered *into* the generator rather than thrown past it,
// so that a plan holding something that must be released — a pin, a reservation,
// a half-applied mutation — gets its `finally` to run. A plan with no handler
// rethrows, which propagates out of the driver unchanged, so the common case is
// unaffected.
//
// The four hand-rolled drive loops this replaces all threw past the generator and
// left it suspended forever.
function deliverError<T>(plan: Plan<T>, err: unknown) {
	return plan.throw(err);
}

export function runSync<T>(plan: Plan<T>): T {
	let step = plan.next();
	while (!step.done) {
		let res: FsResponse;
		try {
			let req: FsRequest = step.value;
			let [ok, bytes, status] = fetchPuterSync(req.url, req.body, req.headers);
			res = makeResponse(ok, status, bytes);
		} catch (err) {
			step = deliverError(plan, err);
			continue;
		}
		step = plan.next(res);
	}
	return step.value;
}

/**
 * `signal` is a driver parameter rather than part of any plan, and only this
 * driver honors it.
 *
 * That asymmetry is honest rather than a gap: on the blocking path the worker
 * thread is *inside* the XHR, so by the time control returns the request has
 * already completed and there was never anything to abort. Checking between steps
 * gives node's semantics for a multi-request operation — the abort takes effect at
 * the next request boundary, and a partly-completed mutating plan stays partly
 * completed, exactly as node leaves a half-finished `cp`.
 */
export async function runAsync<T>(
	plan: Plan<T>,
	signal?: AbortSignal
): Promise<T> {
	// Every async fs operation is a live request as far as the event loop is
	// concerned, exactly as it is in libuv — including one a provider answers without
	// yielding, which is every operation on a memory mount. Without this a program
	// whose only pending work is reading files is indistinguishable from one that has
	// finished, and `drain` lets the host tear it down mid-run. See `refOperation`.
	let release = keepalive.refOperation();
	try {
		let step = plan.next();
		while (!step.done) {
			let res: FsResponse;
			try {
				signal?.throwIfAborted();
				let req: FsRequest = step.value;
				let [ok, bytes, http] = await fetchPuter(
					req.url,
					req.body,
					signal,
					req.headers
				);
				res = makeResponse(ok, http.status, bytes);
			} catch (err) {
				step = deliverError(plan, err);
				continue;
			}
			step = plan.next(res);
		}
		return step.value;
	} finally {
		release();
	}
}
