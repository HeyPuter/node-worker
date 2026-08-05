import { connectToPeer } from "../peer";
import { decode, fetchPuter } from "../puter";
import { WISP_URL } from "../state";
import { FETCH, NATIVE_WEBSOCKET } from "./globals";

let EPOXY_BASE = "https://puter-net.b-cdn.net/epoxy/23493ac";

type JsProtocolExtensionBuilderTy =
	import("./epoxy-wasm").JsProtocolExtensionBuilder;
type PasswordExtCreds = [user: string, pw: string];
type PasswordExtBuilderTy = new (
	toSend: PasswordExtCreds
) => JsProtocolExtensionBuilderTy;

let epoxy: typeof import("./epoxy-wasm");
let PasswordExtBuilder: PasswordExtBuilderTy;
let initialized = false;

export type EpoxyClient = import("./epoxy-wasm").EpoxyClient;
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
	await ensureClient();
}

// Dedup concurrent client creation. Without this, anything that calls
// getClient() while createClient() is still in flight (client not yet assigned)
// kicks off a second createClient() — which is how a single re-entrant call can
// snowball into a storm of relay-dial attempts.
let clientReady: Promise<void> | undefined;
function ensureClient(): Promise<void> {
	if (!clientReady) {
		clientReady = createClient().catch((e) => {
			clientReady = undefined;
			throw e;
		});
	}
	return clientReady;
}

/**
 * Split a wisp v1 URL back into the relay address and the relay token.
 *
 * puter-js builds that URL as `${server}/${token}/` (`generateWispV1URL()`), from
 * the same `wisp/relay-token/create` response this file reads directly — so the
 * last path segment is the token and everything before it is the server. Undoing
 * the concatenation rather than dialing the v1 URL as-is keeps a single handshake
 * path: the token goes over the password extension either way, and a relay whose
 * address has a path prefix of its own (`wss://host/wisp/<token>/`) still works.
 */
function splitWispV1Url(url: string): [server: string, token: string] {
	let parsed = new URL(url);
	let segments = parsed.pathname.split("/").filter((s) => s.length > 0);
	let token = segments.pop();
	if (!token) throw new Error(`wisp url carries no relay token: ${url}`);
	parsed.pathname = segments.length ? `/${segments.join("/")}` : "";
	// `origin` would drop a `wss:` scheme's port on some engines, and `href` would
	// re-add the trailing slash the pathname assignment just cleared.
	return [parsed.toString().replace(/\/$/, ""), token];
}

async function createClient() {
	// Two ways to the same pair. With a puter token the relay credentials are
	// minted per worker; without one the host hands over a complete wisp v1 URL
	// with the token already baked into its path, and we take it apart again.
	let server: string;
	let password: string;
	if (WISP_URL) {
		[server, password] = splitWispV1Url(WISP_URL);
	} else {
		let [ok, u8array] = await fetchPuter("wisp/relay-token/create", {});
		if (!ok) throw new Error("failed to get wisp credentials");
		let creds = decode(u8array);
		server = creds.server;
		password = creds.token;
	}

	// epoxy's WebSocketJsProvider dials the relay through its bundled
	// WebSocketStream polyfill, which calls `new WebSocket(url)` off the global —
	// i.e. our epoxy-backed override, which recurses into getClient(). Replicate
	// the polyfill here over the NATIVE WebSocket so the wisp transport is a real
	// browser socket.
	if (!NATIVE_WEBSOCKET) {
		throw new Error("native WebSocket unavailable for wisp transport");
	}
	let wsProvider = new epoxy.JsProvider(
		(host: string): Promise<any> =>
			new Promise((resolve, reject) => {
				let ws = new NATIVE_WEBSOCKET!(host);
				ws.binaryType = "arraybuffer";
				ws.addEventListener("error", reject, { once: true });
				ws.addEventListener(
					"open",
					() => {
						let readable = new ReadableStream({
							start(controller) {
								ws.onmessage = ({ data }) =>
									controller.enqueue(
										typeof data === "string" ? data : new Uint8Array(data)
									);
								ws.onerror = (e) => controller.error(e);
								ws.onclose = () => {
									try {
										controller.close();
									} catch {}
								};
							},
							cancel() {
								ws.close();
							},
						});
						let writable = new WritableStream({
							write(chunk) {
								ws.send(chunk);
							},
							abort() {
								ws.close();
							},
							close() {
								ws.close();
							},
						});
						resolve([readable, writable]);
					},
					{ once: true }
				);
			})
	);

	let wisp = new epoxy.WispSocketProvider(
		wsProvider,
		server,
		// epoxy >= da3e36c ("align wisp handshake to spec") changed connectionPrefs
		// from a `[handshake, requiredExts]` tuple to a single WispV2Handshake
		// object carrying `requiredExts`. Returning the old tuple makes the wrapper
		// iterate `undefined.builders` and throw before the upstream WS ever opens.
		() => ({
			builders: [new PasswordExtBuilder(["", password])],
			requiredExts: [0x02],
		})
	);

	let peer = new epoxy.JsSocketProvider(async (host, _port) => {
		if (!host.endsWith(".peer.puter.com")) throw new Error("invalid peer host");
		let code = host.slice(0, host.length - ".peer.puter.com".length);
		return await connectToPeer(code);
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
	await ensureClient();
	return client;
}
