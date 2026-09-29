import type { NodeNetInit } from "./net-options";
import { DEFAULT_API_ORIGIN, PuterApi } from "./vfs/puter-http";

export interface PublicUser {
	username: string;
	uuid: string;
	email: string;
}

interface SignallerInfo {
	url: string;
	fallbackIce: RTCIceServer[];
}

const signallerInfo = new Map<string, Promise<SignallerInfo>>();
async function getSignallerInfo(origin: string): Promise<SignallerInfo> {
	let pending = signallerInfo.get(origin);
	if (pending) return pending;
	pending = fetch(`${origin}/peer/signaller-info`)
		.then(async (res) => {
			if (!res.ok) throw new Error("failed to get signaller");
			return (await res.json()) as SignallerInfo;
		})
		.catch((err) => {
			signallerInfo.delete(origin);
			throw err;
		});
	signallerInfo.set(origin, pending);
	return pending;
}

export class NetworkAuth {
	readonly token: string | undefined;
	readonly net: NodeNetInit | undefined;
	readonly apiOrigin: string;
	readonly api: PuterApi | undefined;
	#ice?: { servers: RTCIceServer[]; until: number };

	constructor(
		token: string | undefined,
		net: NodeNetInit | undefined,
		apiOrigin: string = DEFAULT_API_ORIGIN
	) {
		this.token = token || undefined;
		this.net = net;
		this.apiOrigin = apiOrigin.replace(/\/+$/, "") || DEFAULT_API_ORIGIN;
		this.api = this.token
			? new PuterApi(this.token, this.apiOrigin)
			: undefined;
	}

	async user(): Promise<PublicUser> {
		if (!this.api) return { username: "anonymous", uuid: "", email: "" };
		const response = await this.api.fetch("whoami");
		if (!response.ok) throw new Error("failed to fetch user info");
		const body = response.json() as PublicUser;
		return { username: body.username, uuid: body.uuid, email: body.email };
	}

	async relay(): Promise<{ server: string; token?: string }> {
		if (this.net?.wispUrl) {
			return { server: this.net.wispUrl, token: this.net.relayToken };
		}
		if (!this.api)
			throw new Error("no puter token and no relay URL: network unavailable");
		const response = await this.api.fetch("wisp/relay-token/create", {});
		if (!response.ok) throw new Error("failed to get wisp credentials");
		const body = response.json() as { server: string; token: string };
		return { server: body.server, token: body.token };
	}

	peerCredential(): { token: string; anon: boolean } {
		if (this.token) return { token: this.token, anon: false };
		if (this.net?.peerToken) return { token: this.net.peerToken, anon: true };
		throw new Error("no puter token and no peer token: peers are unavailable");
	}

	async peerOptions(): Promise<{
		token: string;
		anon: boolean;
		signaller: string;
		ice: RTCIceServer[];
	}> {
		const credential = this.peerCredential();
		const signaller = await getSignallerInfo(this.apiOrigin);
		let ice: RTCIceServer[];
		if (!this.api) {
			ice = signaller.fallbackIce;
		} else if (this.#ice && Date.now() < this.#ice.until) {
			ice = this.#ice.servers;
		} else {
			const response = await this.api.fetch("peer/generate-turn", {});
			if (!response.ok) throw new Error("failed to get ice servers");
			const body = response.json() as {
				iceServers?: RTCIceServer[];
				fallbackIce?: RTCIceServer[];
				ttl?: number;
			};
			ice = body.iceServers?.length
				? body.iceServers
				: (body.fallbackIce ?? signaller.fallbackIce);
			this.#ice = { servers: ice, until: Date.now() + (body.ttl ?? 0) * 1000 };
		}
		if (!ice?.length) throw new Error("failed to get ice servers");
		return { ...credential, signaller: signaller.url, ice };
	}
}
