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
const realSetTimeout = globalThis.setTimeout;

// Wait until the ref count reaches zero AND stays there across one real
// macrotask. The settle pass catches the common pattern where a handle fires,
// decrements to zero, and then the callback synchronously schedules another
// handle.
export async function drain(): Promise<void> {
	if (!enabled) return;
	while (true) {
		while (refs > 0) {
			await new Promise<void>((r) => waiters.push(r));
		}
		await new Promise<void>((r) => realSetTimeout(r, 0));
		if (refs === 0) return;
	}
}
