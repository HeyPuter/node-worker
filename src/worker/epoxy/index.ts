import { KIND_NET } from "../../wire/kinds";
import type {
	NetCall,
	NetFetchResult,
	NetTlsResult,
	NetWebSocketResult,
} from "../../wire/net";
import { call } from "../wire";
import { platformPrimordials as p } from "../platform-primordials";
import { nodePrimordials as nodeP } from "../node-primordials";
import type {
	EpoxyRawHeaders,
	EpoxyWebSocketOptions,
	EpoxyWSCloseInfo,
	EpoxyWSChunk,
	TlsStreamOptions,
} from "./epoxy-wasm";

export { FETCH, WebSocket, WebSocketStream } from "./globals";

type ByteStream = ReadableStream<Uint8Array>;
type ByteSink = WritableStream<Uint8Array>;

/** The page owns Epoxy and its credentials. This object exposes only network operations. */
const client = {
	async fetch(resource: Request | URL | string, options?: RequestInit) {
		const input = resource instanceof p.Request ? resource : undefined;
		const signal = options?.signal ?? input?.signal;
		if (signal?.aborted)
			throw (
				signal.reason ??
				new p.DOMException("The operation was aborted", "AbortError")
			);
		const url = input?.url ?? p.String(resource);
		const headers = new p.Headers(options?.headers ?? input?.headers);
		const bodyInit = options?.body !== undefined ? options.body : input?.body;
		let body: ByteStream | null = null;
		if (bodyInit != null) {
			if (bodyInit instanceof p.ReadableStream) body = bodyInit as ByteStream;
			else {
				const converted = new p.Response(bodyInit);
				body = converted.body as ByteStream;
				const contentType = p.headersGet(converted.headers, "content-type");
				if (contentType && !p.headersHas(headers, "content-type"))
					p.headersSet(headers, "content-type", contentType);
			}
		}
		const method = options?.method ?? input?.method ?? "GET";
		if (body && (method === "GET" || method === "HEAD"))
			throw new p.TypeError("Request with GET/HEAD method cannot have body");
		const { port1, port2 } = new p.MessageChannel();
		const abort = () => p.messagePortPostMessage(port1, { abort: true });
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			if (signal) p.eventTargetRemoveEventListener(signal, "abort", abort);
			p.messagePortClose(port1);
		};
		if (signal?.aborted) abort();
		else if (signal)
			p.eventTargetAddEventListener(signal, "abort", abort, { once: true });
		const netCall: NetCall = {
			op: "net.fetch",
			url,
			method,
			headers: [...p.headersEntries(headers)] as [string, string][],
			redirect: options?.redirect ?? input?.redirect,
			credentials: options?.credentials ?? input?.credentials,
			cache: options?.cache ?? input?.cache,
			mode: options?.mode ?? input?.mode,
			referrer: options?.referrer ?? input?.referrer,
			referrerPolicy: options?.referrerPolicy ?? input?.referrerPolicy,
			integrity: options?.integrity ?? input?.integrity,
			keepalive: options?.keepalive ?? input?.keepalive,
			hasBody: !!body,
		};
		try {
			const transfer: Transferable[] = body
				? [body as Transferable, port2]
				: [port2];
			const { value, attachments } = await call<NetFetchResult>(
				KIND_NET,
				netCall,
				{ transfer }
			);
			if (signal?.aborted) {
				if (value.hasBody)
					void p.promiseCatch(
						p.readableCancel(attachments[0] as ByteStream),
						() => {}
					);
				throw (
					signal.reason ??
					new p.DOMException("The operation was aborted", "AbortError")
				);
			}
			let responseBody: ByteStream | null = null;
			if (value.hasBody) {
				const reader = p.readableGetReader(
					attachments[0] as ByteStream
				) as ReadableStreamDefaultReader<Uint8Array>;
				responseBody = new p.ReadableStream<Uint8Array>({
					async pull(stream) {
						try {
							const next = await p.readerRead(reader);
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
							await p.readerCancel(reader, reason);
						} finally {
							finish();
						}
					},
				});
			} else finish();
			const response = new p.Response(responseBody, {
				status: value.status,
				statusText: value.statusText,
				headers: value.headers,
			});
			nodeP.ObjectDefineProperties(response, {
				url: { value: value.url },
				redirected: { value: value.redirected },
				type: { value: value.type },
				rawHeaders: { value: value.rawHeaders },
			});
			return response as Response & { rawHeaders: EpoxyRawHeaders };
		} catch (err) {
			finish();
			throw err;
		}
	},
	async websocket(resource: string | URL, options?: EpoxyWebSocketOptions) {
		const { value, attachments } = await call<NetWebSocketResult>(KIND_NET, {
			op: "net.websocket",
			url: p.String(resource),
			protocols:
				typeof options?.protocols === "string"
					? [options.protocols]
					: options?.protocols,
			headers: options?.headers
				? [...p.headersEntries(new p.Headers(options.headers))]
				: undefined,
		} satisfies NetCall);
		const port = attachments[2] as MessagePort;
		let resolve!: (info: EpoxyWSCloseInfo) => void;
		let reject!: (reason: unknown) => void;
		const closed = new p.Promise<EpoxyWSCloseInfo>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		port.onmessage = (
			event: MessageEvent<{ info?: EpoxyWSCloseInfo; error?: string }>
		) => {
			if (event.data.error) reject(new p.Error(event.data.error));
			else resolve(event.data.info ?? {});
			p.messagePortClose(port);
		};
		p.messagePortStart(port);
		return {
			readable: attachments[0] as ReadableStream<EpoxyWSChunk>,
			writable: attachments[1] as WritableStream<EpoxyWSChunk>,
			protocol: value.protocol,
			headers: new p.Headers(value.headers),
			rawHeaders: value.rawHeaders as EpoxyRawHeaders,
			closed,
			close(info?: EpoxyWSCloseInfo) {
				p.messagePortPostMessage(port, info ?? {});
			},
		};
	},
	async connect(host: string, port: number, bufferSize?: number) {
		const { attachments } = await call<null>(KIND_NET, {
			op: "net.tcp",
			host,
			port,
			bufferSize,
		} satisfies NetCall);
		return {
			read: attachments[0] as ByteStream,
			write: attachments[1] as ByteSink,
		};
	},
	async connectTls(host: string, port: number, options?: TlsStreamOptions) {
		const { value, attachments } = await call<NetTlsResult>(KIND_NET, {
			op: "net.tls",
			host,
			port,
			bufferSize: options?.bufferSize,
			alpn: options?.alpn,
		} satisfies NetCall);
		return {
			read: attachments[0] as ByteStream,
			write: attachments[1] as ByteSink,
			negotiatedProtocol: value.negotiatedProtocol,
			protocolVersion: value.protocolVersion,
			cipherSuite: value.cipherSuite,
			peerCertificates: value.peerCertificates.map(
				(cert) => new Uint8Array(cert)
			),
		};
	},
};

export async function getClient() {
	return client;
}
