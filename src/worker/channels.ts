// Named `MessagePort`s the page hands to a program running in this worker.
//
// Everything else the page can say to a program goes through its stdio, and a control protocol
// multiplexed onto stdout is fine right up until the program prints something unexpected —
// which for a shell is not a hypothetical. A port avoids the question: structured clone,
// transferables, its own ordering, and no framing to get wrong.
//
// Ports may arrive before or after the program asks for one, and both orders are ordinary: the
// page usually opens the channel while the program is still being required. So a request that
// arrives first waits, and a port that arrives first is kept.

import { KIND_CHAN } from "../wire/kinds";
import { makeDispatcher } from "../wire/router";
import type { ChanCall } from "../wire/chan";
import { wire } from "./wire";

const ready = new Map<string, MessagePort>();
const waiting = new Map<string, ((port: MessagePort) => void)[]>();

// Its own kind, registered here rather than folded into the control handler, so the
// module that owns the map is the module that fills it.
wire.router.register(
	KIND_CHAN,
	makeDispatcher<ChanCall>(KIND_CHAN, async (call, _parts, attachments) => {
		if (call.op !== "chan.open") {
			// `chan.call` runs in the other direction: it is how a *program* asks its host a
			// question, including from inside a synchronous call. Nothing answers it here.
			throw Object.assign(
				new Error(`ENOSYS: ${call.op} is not answered by the worker`),
				{ code: "ENOSYS" }
			);
		}
		const port = attachments[0] as MessagePort | undefined;
		if (!port) {
			throw Object.assign(
				new Error(`chan.open("${call.name}") carried no port`),
				{ code: "EINVAL" }
			);
		}
		deliverChannel(call.name, port);
	})
);

/** @internal Called when the page opens one. */
function deliverChannel(name: string, port: MessagePort): void {
	const pending = waiting.get(name);
	if (pending?.length) {
		waiting.delete(name);
		for (const resolve of pending) resolve(port);
		return;
	}
	ready.set(name, port);
}

/**
 * The port the page opened under `name`, waiting for it if it has not arrived.
 *
 * Never rejects and never times out. A program that asks for a channel nobody opens is a
 * program waiting for its host, which is the same thing a server waiting for a connection is —
 * whoever wants a deadline can race one.
 */
export function channel(name: string): Promise<MessagePort> {
	const already = ready.get(name);
	if (already) {
		ready.delete(name);
		return Promise.resolve(already);
	}
	return new Promise((resolve) => {
		const queue = waiting.get(name) ?? [];
		queue.push(resolve);
		waiting.set(name, queue);
	});
}
