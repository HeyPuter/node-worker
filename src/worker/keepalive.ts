// Optional event-loop keepalive. Tracks "active handles" (refed timers, listening
// servers, etc.) the way Node's libuv does: while the count is non-zero, the
// worker's `execute` reply is held back from settling. The host page sees the
// reply only after the run has truly drained, mimicking Node's "exit when no
// more handles" behavior.
//
// Off by default. The handler opts in via the `keepalive` flag on init.

let enabled = false;
let refs = 0;
let waiters: Array<() => void> = [];

export function setKeepaliveEnabled(value: boolean) {
	enabled = value;
}

export function isKeepaliveEnabled(): boolean {
	return enabled;
}

export function ref() {
	if (!enabled) return;
	refs++;
}

export function unref() {
	if (!enabled) return;
	if (refs === 0) return;
	refs--;
	if (refs === 0) {
		let pending = waiters;
		waiters = [];
		for (let w of pending) w();
	}
}

export function refCount(): number {
	return refs;
}

// Native setTimeout, captured before any Node-side wrapping can shadow it.
// A macrotask scheduled with this does NOT enroll in the ref count, so the
// settle pass below can't keep itself alive.
const realSetTimeout = globalThis.setTimeout;

// Yield to a real macrotask. When it resolves, the microtask *and* process.
// nextTick queues have fully drained (both run before the next macrotask), so
// any synchronous- or microtask-scheduled re-ref has already happened.
function nextMacrotask(): Promise<void> {
	return new Promise<void>((r) => realSetTimeout(r, 0));
}

// Resolve once the run has quiesced the way libuv's event loop would stop:
// no active refed handles remain. `refs` is the analogue of libuv's refed
// active-handle count. Contributors while live: refed timers/immediates (via
// the timers binding), listening servers, connected/connecting sockets (which
// also back http, https, tls and the http2 client), in-flight fetches, and a
// reading stdin.
//
// Node re-checks loop liveness only after draining the microtask/nextTick
// queues following each callback, so we mirror that: wait for refs to reach 0,
// let one macrotask (i.e. a full microtask/nextTick drain) elapse, and confirm
// nothing re-refed. If something did (a queued tick scheduled a new timer, a
// timer callback re-armed, an immediate chained), loop and wait again.
//
// Faithfulness is bounded by ref coverage. The known remaining gap is response
// body streaming after a fetch() resolves (the fetch is reffed only through its
// headers phase), which can briefly read refs as 0 mid-stream if nothing else
// is live — narrow in practice.
export async function drain(): Promise<void> {
	if (!enabled) return;
	while (true) {
		while (refs > 0) {
			await new Promise<void>((r) => waiters.push(r));
		}
		await nextMacrotask();
		if (refs === 0) return;
	}
}
