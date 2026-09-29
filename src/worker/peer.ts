import { KIND_PEER } from "../wire/kinds";
import type { PeerResult } from "../wire/peer";
import { call } from "./wire";
import { platformPrimordials as platform } from "./platform-primordials";

/** The page owns the signaller, ICE configuration, and credentials. */
export async function connectToPeer(target: {
	code?: string;
	port?: number;
}): Promise<[
	ReadableStream<Uint8Array<ArrayBuffer>>,
	WritableStream<Uint8Array<ArrayBuffer>>,
]> {
	const { attachments } = await call<PeerResult<"peer.connect">>(KIND_PEER, {
		op: "peer.connect",
		code: target.code,
		port: target.port,
	});
	return [
		attachments[0] as ReadableStream<Uint8Array<ArrayBuffer>>,
		attachments[1] as WritableStream<Uint8Array<ArrayBuffer>>,
	];
}

export async function hostPeerServer(
	port: number,
	cb: (stream: [
		ReadableStream<Uint8Array<ArrayBuffer>>,
		WritableStream<Uint8Array<ArrayBuffer>>,
	]) => void
): Promise<{ code: string; close: () => void }> {
	const { value, attachments } = await call<PeerResult<"peer.listen">>(
		KIND_PEER,
		{ op: "peer.listen", port }
	);
	const accepted = attachments[0] as MessagePort;
	accepted.onmessage = (e) => cb([e.data.readable, e.data.writable]);
	return {
		code: value.code,
		close: () => platform.messagePortPostMessage(accepted, { close: true }),
	};
}
