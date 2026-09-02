import { connectToPeer } from "../peer";
import { decode, fetchPuter } from "../puter";
import { RELAY_TOKEN, WISP_URL } from "../state";
import { FETCH, NATIVE_WEBSOCKET } from "./globals";

// epoxy-tls 43ed248. Bumped from 04e4930, which never requested the Wisp v2 subprotocol: the spec
// makes `Sec-WebSocket-Protocol` mandatory for a v2 handshake (its value is unspecified), and a
// relay that sees no header answers v1 — so 0x02 was never negotiated and the relay token below
// went unverified. 43ed248 asks the transport for the subprotocol and enforces `requiredExts` when
// a relay answers v1 instead of downgrading in silence, which is why the provider further down has
// to forward `protocol` to the socket rather than dropping it.
//
// Do not go below 04e4930, which carried `7687e2c fix wisp-mux bugs`: before it, two TLS
// connections opened in the same tick stranded one of them — which is every concurrent request a
// program makes, and every connectivity preflight.
let EPOXY_BASE = "https://puter-net.b-cdn.net/epoxy/43ed248";

/**
 * Point epoxy at a different build. See `NodeWorkerOptions.epoxyBase`.
 *
 * Must be called before `init`, which is the only reader; a trailing slash is trimmed so
 * either spelling of the base works.
 */
export function setEpoxyBase(base: string | undefined) {
	if (base) EPOXY_BASE = base.replace(/\/+$/, "");
}

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

async function createClient() {
	// An address, and optionally a token to authenticate with. With a puter token the
	// pair is minted per worker; without one the host supplies it — see `NodeNetInit`.
	//
	// Nothing is derived from the address either way. The relay decides what its own
	// path means, so a v1 URL carrying its token in the path reaches the relay with it
	// intact, and a relay authenticating over the password extension is handed the
	// token separately. Guessing which one a URL was by taking it apart is what this
	// used to do, and it made every relay that isn't puter's unreachable: the token was
	// stripped out of the path it was meant to ride in, then 0x02 was demanded of a
	// relay that may not implement it.
	let server: string;
	let password: string | undefined;
	if (WISP_URL) {
		server = WISP_URL;
		password = RELAY_TOKEN;
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
	//
	// `protocol` is epoxy asking for a websocket subprotocol, and it is only set when
	// a v2 handshake was requested. It has to reach the socket: the spec requires the
	// header be present for v2, so a relay that does not see one answers v1, and a
	// transport that drops the argument can only ever speak v1 — which for a puter
	// relay means the token below is never checked.
	if (!NATIVE_WEBSOCKET) {
		throw new Error("native WebSocket unavailable for wisp transport");
	}
	let wsProvider = new epoxy.JsProvider(
		(host: string, protocol?: string): Promise<any> =>
			new Promise((resolve, reject) => {
				let ws = new NATIVE_WEBSOCKET!(host, protocol ? [protocol] : []);
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
		//
		// An empty handshake, NOT `undefined`, is what a relay with no `password` gets.
		// `undefined` asks wisp-mux for a v1 client, and a v1 client cannot talk to a v2
		// relay: the relay writes its INFO packet before reading anything (mux/server.rs
		// `handshake`), while a v1 client requires that first packet to be CONTINUE and
		// errors with InvalidPacketType on anything else. Only the *v2* client has a
		// fallback — a first packet that isn't INFO downgrades it to v1 — so negotiating
		// v2 with nothing in it is what reaches both kinds of relay. An empty
		// `requiredExts` can never fail: `missing_required_extensions` filters the
		// required list against what the relay offered, and filtering nothing is nothing.
		//
		// `requiredExts: [0x02]` alongside a token is the deliberate opposite: a relay
		// that ignores the password is one that would let the connection through
		// unauthenticated, and failing the handshake says so. As of 43ed248 that holds
		// on the downgrade path too — a relay that answers v1 is now checked against the
		// required list (v1 counts as offering UDP and nothing else) instead of quietly
		// dropping it, so a token can no longer go unverified without the dial failing.
		() =>
			password === undefined
				? { builders: [], requiredExts: [] }
				: {
						builders: [new PasswordExtBuilder(["", password])],
						requiredExts: [0x02],
					}
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
