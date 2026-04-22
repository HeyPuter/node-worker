import { send } from ".";
import { console_warn } from "./console";
import { decode, fetchPuter } from "./puter";
import { PUTER_TOKEN } from "./state";

interface IceServerState {
	servers: RTCIceServer[];
	fetchedAt: number;
	ttl: number;
}

let signaller: string | undefined;
async function getSignaller(): Promise<string> {
	if (signaller) return signaller;

	let [ok, u8array] = await fetchPuter("peer/signaller-info");
	if (!ok) throw new Error("failed to get signaller");
	let { url } = decode(u8array);
	signaller = url;

	return url;
}

let iceState: IceServerState | undefined;
async function getIceServers(): Promise<RTCIceServer[]> {
	if (iceState && (Date.now() - iceState.fetchedAt) < (iceState.ttl * 1000))
		return iceState.servers;

	let [ok, u8array] = await fetchPuter("peer/generate-turn", {});
	if (!ok) throw new Error("failed to get ice servers");
	let { iceServers, ttl, fallbackIce } = decode(u8array);

	if (!iceServers?.length) {
		console_warn("[node-worker] [peer] unable to fetch turn relays");
		iceServers = fallbackIce;
	}

	iceState = { servers: iceServers, fetchedAt: Date.now(), ttl };

	return iceServers;
}

export async function connectToPeer(code: string): Promise<[ReadableStream<Uint8Array<ArrayBuffer>>, WritableStream<Uint8Array<ArrayBuffer>>]> {
	if (!PUTER_TOKEN) throw new Error("not logged in");

	let res = await send("peer-client", { token: PUTER_TOKEN, signaller: await getSignaller(), ice: await getIceServers(), code });

	return [res.readable, res.writable];
}

export async function hostPeerServer(cb: (stream: [ReadableStream<Uint8Array<ArrayBuffer>>, WritableStream<Uint8Array<ArrayBuffer>>]) => void): Promise<string> {
	if (!PUTER_TOKEN) throw new Error("not logged in");

	let res = await send("peer-server", { token: PUTER_TOKEN, signaller: await getSignaller(), ice: await getIceServers() });

	res.port.onmessage = e => {
		cb([e.data.readable, e.data.writable]);
	};

	return res.code;
}
