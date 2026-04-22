import { connectToPeer } from "../peer";
import { decode, fetchPuter } from "../puter";
import { FETCH } from "./globals";

let EPOXY_BASE = "https://puter-net.b-cdn.net/epoxy/f006127";

type JsProtocolExtensionBuilderTy =
	import("../epoxy-wasm").JsProtocolExtensionBuilder;
type PasswordExtCreds = [user: string, pw: string];
type PasswordExtBuilderTy = new (
	toSend: PasswordExtCreds
) => JsProtocolExtensionBuilderTy;

let epoxy: typeof import("../epoxy-wasm");
let PasswordExtBuilder: PasswordExtBuilderTy;
let initialized = false;

export type EpoxyClient = import("../epoxy-wasm").EpoxyClient;
let client: EpoxyClient;
export { FETCH, WebSocket, WebSocketStream } from "./globals";

export async function init() {
	epoxy = await import(/* @vite-ignore */ `${EPOXY_BASE}/full.js`);
	let wasm = await FETCH(`${EPOXY_BASE}/full.wasm`);

	await epoxy.init({ module_or_path: wasm });

	class PasswordExt extends epoxy.JsProtocolExtension {
		toSend?: PasswordExtCreds;
		required?: boolean;

		constructor(required?: boolean, toSend?: PasswordExtCreds) {
			super(0x02, [], []);
			this.toSend = toSend;
			this.required = required;
		}

		encode() {
			if (this.toSend) {
				let [_user, _pw] = this.toSend;
				let user = new TextEncoder().encode(_user);
				let pw = new TextEncoder().encode(_pw);

				let arr = new Uint8Array(3 + user.byteLength + pw.byteLength);
				arr[0] = user.byteLength;
				new DataView(arr.buffer).setUint16(1, pw.byteLength, true);
				arr.set(user, 3);
				arr.set(pw, 3 + user.byteLength);

				return arr;
			}
			return new Uint8Array();
		}
	}

	PasswordExtBuilder = class extends epoxy.JsProtocolExtensionBuilder {
		toSend;

		constructor(toSend: PasswordExtCreds) {
			super(0x02);

			this.toSend = toSend;
		}

		buildFromBytes(bytes: Uint8Array) {
			return new PasswordExt(bytes[0] !== 0);
		}

		buildToExtension() {
			return new PasswordExt(undefined, this.toSend);
		}
	};

	initialized = true;
	await createClient();
}

async function createClient() {
	let [ok, u8array] = await fetchPuter("wisp/relay-token/create", {});
	if (!ok) throw new Error("failed to get wisp credentials");
	let { server, token: password } = decode(u8array);

	let wisp = new epoxy.WispSocketProvider(
		new epoxy.WebSocketJsProvider(),
		server,
		() => [{ builders: [new PasswordExtBuilder(["", password])] }, [0x02]]
	);

	let peer = new epoxy.JsSocketProvider(async (host, _port) => {
		if (!host.endsWith(".peer.puter.com")) throw new Error("invalid peer host");
		let code = host.slice(0, host.length - ".peer.puter.com".length);

		let peer = await connectToPeer(code);
		
		return peer;
	});

	let provider = new epoxy.EitherSocketProvider((host) => {
		if (host.endsWith(".peer.puter.com")) return "right";
		else return "left";
	}, wisp, peer);

	client = new epoxy.EpoxyClient(provider);
}

export async function getClient(): Promise<EpoxyClient> {
	if (!initialized) throw new Error("epoxy not initialized");
	if (client) return client;
	await createClient();
	return client;
}
