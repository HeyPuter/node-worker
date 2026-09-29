import { NetworkAuth } from "./network-auth";
import { handlePeerConnect, type PeerConnectHandle } from "./peer";
import type { NodeNetInit } from "./net-options";
import type {
	NetCall,
	NetFetchResult,
	NetTlsResult,
	NetWebSocketResult,
} from "../wire/net";
import type { Answered } from "../wire/router";
import type { EpoxyClient, EpoxyWS } from "../worker/epoxy/epoxy-wasm";

type TcpStream = Awaited<ReturnType<EpoxyClient["connect"]>>;
type TlsStream = Awaited<ReturnType<EpoxyClient["connectTls"]>>;

const DEFAULT_EPOXY_BASE = "https://puter-net.b-cdn.net/epoxy/43ed248";
type Epoxy = typeof import("../worker/epoxy/epoxy-wasm");
type Password = [string, string];

const loaded = new Map<string, Promise<Epoxy>>();
function loadEpoxy(base: string): Promise<Epoxy> {
	let pending = loaded.get(base);
	if (!pending) {
		pending = (async () => {
			try {
				const epoxy: Epoxy = await import(/* @vite-ignore */ `${base}/full.js`);
				await epoxy.init({ module_or_path: await fetch(`${base}/full.wasm`) });
				return epoxy;
			} catch (err) {
				throw new Error(
					`epoxy failed to load from ${base} — check NodeWorkerOptions.epoxyBase (cause: ${(err as Error)?.message ?? err})`,
					{ cause: err }
				);
			}
		})();
		loaded.set(base, pending);
		pending.catch(() => loaded.delete(base));
	}
	return pending;
}

/** A relay provider is shared by workers with the same network configuration. */
const relays = new Map<
	string,
	Promise<InstanceType<Epoxy["WispSocketProvider"]>>
>();
async function relayProvider(epoxy: Epoxy, auth: NetworkAuth, base: string) {
	const key = auth.net?.wispUrl
		? JSON.stringify([base, auth.net.wispUrl, auth.net.relayToken])
		: JSON.stringify([base, auth.apiOrigin, auth.token]);
	let pending = relays.get(key);
	if (!pending) {
		pending = (async () => {
			const { server, token } = await auth.relay();
			class PasswordExt extends epoxy.JsProtocolExtension {
				constructor(
					readonly required?: boolean,
					readonly toSend?: Password
				) {
					super(0x02, [], []);
				}
				encode() {
					if (!this.toSend) return new Uint8Array();
					const user = new TextEncoder().encode(this.toSend[0]);
					const pw = new TextEncoder().encode(this.toSend[1]);
					const bytes = new Uint8Array(3 + user.length + pw.length);
					bytes[0] = user.length;
					new DataView(bytes.buffer).setUint16(1, pw.length, true);
					bytes.set(user, 3);
					bytes.set(pw, 3 + user.length);
					return bytes;
				}
			}
			class PasswordBuilder extends epoxy.JsProtocolExtensionBuilder {
				constructor(readonly toSend: Password) {
					super(0x02);
				}
				buildFromBytes(bytes: Uint8Array) {
					return new PasswordExt(bytes[0] !== 0);
				}
				buildToExtension() {
					return new PasswordExt(undefined, this.toSend);
				}
			}
			const native = new epoxy.JsProvider(
				(host: string, protocol?: string): Promise<any> =>
					new Promise((resolve, reject) => {
						const ws = new WebSocket(host, protocol ? [protocol] : []);
						ws.binaryType = "arraybuffer";
						ws.addEventListener("error", reject, { once: true });
						ws.addEventListener(
							"open",
							() => {
								const readable = new ReadableStream({
									start(controller) {
										ws.onmessage = ({ data }) =>
											controller.enqueue(
												typeof data === "string" ? data : new Uint8Array(data)
											);
										ws.onerror = (err) => controller.error(err);
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
								const writable = new WritableStream({
									write(chunk) {
										ws.send(chunk);
									},
									close() {
										ws.close();
									},
									abort() {
										ws.close();
									},
								});
								resolve([readable, writable]);
							},
							{ once: true }
						);
					})
			);
			return new epoxy.WispSocketProvider(native, server, () =>
				token === undefined
					? { builders: [], requiredExts: [] }
					: { builders: [new PasswordBuilder(["", token])], requiredExts: [] }
			);
		})();
		relays.set(key, pending);
		pending.catch(() => relays.delete(key));
	}
	return pending;
}

export class NetworkService {
	readonly auth: NetworkAuth;
	readonly base: string;
	readonly track: <T extends { close(): void; closed?: Promise<void> }>(
		resource: T
	) => T;
	#client?: Promise<EpoxyClient>;
	#closed = false;
	#resources = new Set<{ close(): void }>();

	constructor(
		token: string | undefined,
		net: NodeNetInit | undefined,
		apiOrigin: string | undefined,
		base: string | undefined,
		track: <T extends { close(): void; closed?: Promise<void> }>(
			resource: T
		) => T
	) {
		this.auth = new NetworkAuth(token, net, apiOrigin);
		this.base = (base ?? DEFAULT_EPOXY_BASE).replace(/\/+$/, "");
		this.track = track;
	}

	async #getClient(): Promise<EpoxyClient> {
		if (this.#closed) throw new Error("network service closed");
		return (this.#client ??= (async () => {
			const epoxy = await loadEpoxy(this.base);
			const wisp = await relayProvider(epoxy, this.auth, this.base);
			const peer = new epoxy.JsSocketProvider(
				async (host: string, _port: number) => {
					if (!host.endsWith(".peer.puter.com"))
						throw new Error("invalid peer host");
					const options = await this.auth.peerOptions();
					const code = host.slice(0, -".peer.puter.com".length);
					const connection: PeerConnectHandle = this.track(
						await handlePeerConnect(
							options.token,
							{ code },
							options.signaller,
							options.ice,
							options.anon
						)
					);
					return [connection.readable, connection.writable];
				}
			);
			const provider = new epoxy.EitherSocketProvider(
				(host: string) => (host.endsWith(".peer.puter.com") ? "right" : "left"),
				wisp,
				peer
			);
			return new epoxy.EpoxyClient(provider);
		})().catch((err) => {
			this.#client = undefined;
			throw err;
		}));
	}

	#own(resource: { close(): void }) {
		if (this.#closed) resource.close();
		else this.#resources.add(resource);
		return () => this.#resources.delete(resource);
	}

	#exposeConnection(stream: TcpStream | TlsStream): Transferable[] {
		const reader = stream.read.getReader();
		const writer = stream.write.getWriter();
		let readDone = false;
		let writeDone = false;
		let forget = () => {};
		const maybeForget = () => {
			if (readDone && writeDone) forget();
		};
		const close = () => {
			if (!readDone) {
				readDone = true;
				void reader.cancel().catch(() => {});
			}
			if (!writeDone) {
				writeDone = true;
				void writer.abort().catch(() => {});
			}
			forget();
		};
		forget = this.#own({ close });
		const readable = new ReadableStream<Uint8Array>({
			async pull(target) {
				try {
					const next = await reader.read();
					if (next.done) {
						readDone = true;
						maybeForget();
						target.close();
					} else target.enqueue(next.value);
				} catch (err) {
					readDone = true;
					maybeForget();
					target.error(err);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					readDone = true;
					maybeForget();
				}
			},
		});
		const writable = new WritableStream<Uint8Array>({
			write(chunk) {
				return writer.write(chunk);
			},
			async close() {
				try {
					await writer.close();
				} finally {
					writeDone = true;
					maybeForget();
				}
			},
			async abort(reason) {
				try {
					await writer.abort(reason);
				} finally {
					writeDone = true;
					maybeForget();
				}
			},
		});
		return [readable as Transferable, writable as Transferable];
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const resource of this.#resources) {
			try {
				resource.close();
			} catch {}
		}
		this.#resources.clear();
	}

	async handle(
		call: NetCall,
		attachments: readonly unknown[]
	): Promise<Answered> {
		if (this.#closed) throw new Error("network service closed");
		if (call.op === "net.fetch") {
			const controller = new AbortController();
			const port = attachments[call.hasBody ? 1 : 0] as MessagePort;
			let finished = false;
			let forget = () => {};
			let onAbort = () => {};
			const finish = () => {
				if (finished) return;
				finished = true;
				controller.signal.removeEventListener("abort", onAbort);
				forget();
				port.close();
			};
			forget = this.#own({
				close: () => {
					controller.abort();
					finish();
				},
			});
			port.onmessage = () => controller.abort();
			const init: RequestInit & { duplex?: "half" } = {
				method: call.method,
				headers: call.headers,
				redirect: call.redirect,
				credentials: call.credentials,
				cache: call.cache,
				mode: call.mode,
				referrer: call.referrer,
				referrerPolicy: call.referrerPolicy,
				integrity: call.integrity,
				keepalive: call.keepalive,
				signal: controller.signal,
			};
			if (call.hasBody) {
				init.body = attachments[0] as ReadableStream<Uint8Array>;
				init.duplex = "half";
			}
			try {
				const aborted = new Promise<never>((_resolve, reject) => {
					onAbort = () =>
						reject(new DOMException("The operation was aborted", "AbortError"));
					controller.signal.addEventListener("abort", onAbort, { once: true });
					if (controller.signal.aborted) onAbort();
				});
				const client = await Promise.race([this.#getClient(), aborted]);
				const response = await client.fetch(call.url, init);
				if (this.#closed || controller.signal.aborted) {
					if (response.body) void response.body.cancel().catch(() => {});
					throw new DOMException("The operation was aborted", "AbortError");
				}
				const value: NetFetchResult = {
					status: response.status,
					statusText: response.statusText,
					headers: [...response.headers.entries()],
					rawHeaders: response.rawHeaders,
					url: response.url,
					redirected: response.redirected,
					type: response.type,
					hasBody: !!response.body,
				};
				if (!response.body) {
					finish();
					return { value };
				}
				const reader = response.body.getReader();
				const body = new ReadableStream<Uint8Array>({
					async pull(stream) {
						try {
							const next = await reader.read();
							if (next.done) {
								stream.close();
								finish();
							} else stream.enqueue(next.value);
						} catch (err) {
							stream.error(err);
							finish();
						}
					},
					async cancel(reason) {
						try {
							await reader.cancel(reason);
						} finally {
							finish();
						}
					},
				});
				return { value, transfer: [body as Transferable] };
			} catch (err) {
				if (call.hasBody)
					void (attachments[0] as ReadableStream).cancel().catch(() => {});
				finish();
				throw err;
			}
		}
		if (call.op === "net.websocket") {
			const client = await this.#getClient();
			if (this.#closed) throw new Error("network service closed");
			const ws: EpoxyWS = await client.websocket(call.url, {
				protocols: call.protocols,
				headers: call.headers,
			});
			if (this.#closed) {
				ws.close();
				throw new Error("network service closed");
			}
			const { port1, port2 } = new MessageChannel();
			const forget = this.#own({ close: () => ws.close() });
			port1.onmessage = (event) => ws.close(event.data);
			void ws.closed.then(
				(info) => {
					port1.postMessage({ info });
					port1.close();
					forget();
				},
				(err) => {
					port1.postMessage({ error: String(err) });
					port1.close();
					forget();
				}
			);
			const value: NetWebSocketResult = {
				protocol: ws.protocol,
				headers: [...ws.headers.entries()],
				rawHeaders: ws.rawHeaders,
			};
			return {
				value,
				transfer: [
					ws.readable as Transferable,
					ws.writable as Transferable,
					port2,
				],
			};
		}
		const client = await this.#getClient();
		if (this.#closed) throw new Error("network service closed");
		const stream: TcpStream | TlsStream =
			call.op === "net.tls"
				? await client.connectTls(call.host, call.port, {
						alpn: call.alpn,
						bufferSize: call.bufferSize,
					})
				: await client.connect(call.host, call.port, call.bufferSize);
		if (this.#closed) {
			void stream.read.cancel().catch(() => {});
			void stream.write.abort().catch(() => {});
			throw new Error("network service closed");
		}
		const value: NetTlsResult | null =
			call.op === "net.tls"
				? {
						negotiatedProtocol: (stream as TlsStream).negotiatedProtocol,
						protocolVersion: (stream as TlsStream).protocolVersion,
						cipherSuite: (stream as TlsStream).cipherSuite,
						peerCertificates: (stream as TlsStream).peerCertificates.map(
							(cert) => [...cert]
						),
					}
				: null;
		return { value, transfer: this.#exposeConnection(stream) };
	}
}
