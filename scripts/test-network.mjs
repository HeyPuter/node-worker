import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rollup } from "rollup";
import typescript from "@rollup/plugin-typescript";

const root = path.resolve(import.meta.dirname, "..");
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodeworker-epoxy-"));
fs.writeFileSync(path.join(mockDir, "package.json"), '{"type":"module"}');
fs.writeFileSync(
	path.join(mockDir, "full.js"),
	`
export async function init() {}
export class JsProtocolExtension { constructor() {} }
export class JsProtocolExtensionBuilder { constructor() {} }
export class JsProvider { constructor(connect) { this.connect = connect; } }
export class WispSocketProvider { constructor() { globalThis.__networkMock.providers++; } }
export class JsSocketProvider { constructor(connect) { this.connect = connect; } }
export class EitherSocketProvider { constructor() {} }
export class EpoxyClient {
  constructor() {}
  async fetch(url, init) {
    const body = init.body ? await new Response(init.body).text() : "";
    globalThis.__networkMock.requests.push({ url, method: init.method, body, headers: init.headers });
    const response = new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode("reply:" + body)); c.close();
    } }), { status: 201, headers: { "x-test": "ok" } });
    response.rawHeaders = { "x-test": ["ok"] };
    return response;
  }
  async websocket() {
    let resolve;
    const closed = new Promise((r) => { resolve = r; });
    return {
      protocol: "test", headers: new Headers({ "x-ws": "ok" }), rawHeaders: { "x-ws": ["ok"] },
      readable: new ReadableStream({ start(c) { c.enqueue("message"); c.close(); } }),
      writable: new WritableStream(), closed,
      close(info) { resolve(info ?? {}); },
    };
  }
  async connect() { return this.stream(); }
  async connectTls() {
    return Object.assign(this.stream(), { negotiatedProtocol: "h2", protocolVersion: "TLSv1.3",
      cipherSuite: "TLS_AES_128_GCM_SHA256", peerCertificates: [new Uint8Array([1, 2, 3])] });
  }
  stream() {
    return {
      read: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([4, 5])); c.close(); } }),
      write: new WritableStream({ write(c) { globalThis.__networkMock.writes.push([...c]); } }),
    };
  }
}
`
);

const entry = "\0network-test-entry";
const bundle = await rollup({
	input: "network-test-entry",
	plugins: [
		{
			name: "network-test-entry",
			resolveId(id) {
				return id === "network-test-entry" ? entry : null;
			},
			load(id) {
				return id === entry
					? `export { NetworkService } from ${JSON.stringify(path.join(root, "src/lib/network.ts"))};`
					: null;
			},
		},
		typescript({
			tsconfig: path.join(root, "tsconfig.main.json"),
			declaration: false,
		}),
	],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();
const { NetworkService } = await import(
	`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
);

const proxyEntry = "\0network-proxy-test-entry";
const proxyBundle = await rollup({
	input: "network-proxy-test-entry",
	plugins: [
		{
			name: "network-proxy-test-entry",
			resolveId(id, importer) {
				if (id === "network-proxy-test-entry") return proxyEntry;
				if (!importer?.endsWith("/src/worker/epoxy/index.ts")) return null;
				if (id === "../wire") return "\0mock-wire";
				if (id === "./globals") return "\0mock-globals";
				if (id === "../node-primordials") return "\0mock-primordials";
				return null;
			},
			load(id) {
				if (id === proxyEntry)
					return `export { getClient } from ${JSON.stringify(path.join(root, "src/worker/epoxy/index.ts"))};`;
				if (id === "\0mock-wire")
					return "export const call = (kind, request, options) => globalThis.__networkCall(kind, request, options);";
				if (id === "\0mock-globals")
					return "export const FETCH = globalThis.fetch; export const WebSocket = globalThis.WebSocket; export const WebSocketStream = null;";
				if (id === "\0mock-primordials")
					return "export const nodePrimordials = { ObjectDefineProperties: Object.defineProperties };";
				return null;
			},
		},
		typescript({
			tsconfig: path.join(root, "tsconfig.worker.json"),
			declaration: false,
		}),
	],
});
const proxyOutput = await proxyBundle.generate({ format: "es" });
await proxyBundle.close();
const { getClient } = await import(
	`data:text/javascript;base64,${Buffer.from(proxyOutput.output[0].code).toString("base64")}`
);

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	assert.equal(url, `${pathToFileURL(mockDir).href}/full.wasm`);
	return new Response(new Uint8Array());
};
globalThis.__networkMock = { providers: 0, requests: [], writes: [] };
try {
	const base = pathToFileURL(mockDir).href;
	const first = new NetworkService(
		undefined,
		{ wispUrl: "wss://relay.invalid/" },
		undefined,
		base,
		(resource) => resource
	);
	const second = new NetworkService(
		undefined,
		{ wispUrl: "wss://relay.invalid/" },
		undefined,
		base,
		(resource) => resource
	);
	globalThis.__networkCall = async (kind, request, options) => {
		assert.equal(kind, 7);
		const answered = await first.handle(request, options?.transfer ?? []);
		return { value: answered.value, attachments: answered.transfer ?? [] };
	};
	const channel = new MessageChannel();
	const body = new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode("body"));
			c.close();
		},
	});
	const fetched = await first.handle(
		{
			op: "net.fetch",
			url: "https://example.test/",
			method: "POST",
			headers: [["x-request", "yes"]],
			hasBody: true,
		},
		[body, channel.port2]
	);
	assert.equal(fetched.value.status, 201);
	assert.equal(await new Response(fetched.transfer[0]).text(), "reply:body");
	assert.deepEqual(globalThis.__networkMock.requests, [
		{
			url: "https://example.test/",
			method: "POST",
			body: "body",
			headers: [["x-request", "yes"]],
		},
	]);
	channel.port1.close();

	const ws = await first.handle(
		{ op: "net.websocket", url: "wss://example.test/" },
		[]
	);
	assert.equal(ws.value.protocol, "test");
	const control = ws.transfer[2];
	const closed = new Promise((resolve) => {
		control.onmessage = (event) => resolve(event.data);
	});
	control.postMessage({ closeCode: 1000, reason: "done" });
	assert.deepEqual(await closed, { info: { closeCode: 1000, reason: "done" } });
	control.close();

	const tcp = await second.handle(
		{ op: "net.tcp", host: "example.test", port: 80 },
		[]
	);
	const tcpReader = tcp.transfer[0].getReader();
	assert.deepEqual([...(await tcpReader.read()).value], [4, 5]);
	assert.equal((await tcpReader.read()).done, true);
	const tcpWriter = tcp.transfer[1].getWriter();
	await tcpWriter.write(new Uint8Array([9]));
	await tcpWriter.close();
	assert.deepEqual(globalThis.__networkMock.writes, [[9]]);

	const tls = await second.handle(
		{ op: "net.tls", host: "example.test", port: 443, alpn: ["h2"] },
		[]
	);
	assert.equal(tls.value.negotiatedProtocol, "h2");
	assert.deepEqual(tls.value.peerCertificates, [[1, 2, 3]]);
	assert.equal(globalThis.__networkMock.providers, 1);
	const proxied = await getClient();
	const proxiedResponse = await proxied.fetch("https://example.test/upload", {
		method: "POST",
		headers: { "x-proxy": "yes" },
		body: new Blob(["blob-data"], { type: "text/plain" }),
	});
	assert.equal(proxiedResponse.status, 201);
	assert.equal(await proxiedResponse.text(), "reply:blob-data");
	assert.deepEqual(proxiedResponse.rawHeaders, { "x-test": ["ok"] });
	assert.deepEqual(globalThis.__networkMock.requests.at(-1), {
		url: "https://example.test/upload",
		method: "POST",
		body: "blob-data",
		headers: [
			["content-type", "text/plain"],
			["x-proxy", "yes"],
		],
	});
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(
		proxied.fetch("https://example.test/abort", { signal: aborted.signal }),
		{ name: "AbortError" }
	);
	const proxiedWs = await proxied.websocket("wss://example.test/");
	proxiedWs.close({ closeCode: 1000, reason: "done" });
	assert.deepEqual(await proxiedWs.closed, { closeCode: 1000, reason: "done" });
	const proxiedTls = await proxied.connectTls("example.test", 443, {
		alpn: ["h2"],
	});
	assert.equal(proxiedTls.negotiatedProtocol, "h2");
	assert.deepEqual([...proxiedTls.peerCertificates[0]], [1, 2, 3]);
	first.close();
	second.close();

	const customOrigin = "https://api.custom.test";
	const requests = [];
	globalThis.fetch = async (input, init) => {
		const url = new URL(input);
		assert.equal(url.origin, customOrigin);
		requests.push({
			path: url.pathname,
			queryToken: url.searchParams.get("auth_token"),
			headerToken: init?.headers?.Authorization,
		});
		const body =
			url.pathname === "/whoami"
				? { username: "tester", uuid: "user-id", email: "tester@example.test" }
				: url.pathname === "/wisp/relay-token/create"
					? { server: "wss://relay.custom.test", token: "relay-secret" }
					: url.pathname === "/peer/signaller-info"
						? {
								url: "wss://signal.custom.test",
								fallbackIce: [{ urls: "stun:stun.custom.test" }],
							}
						: { iceServers: [{ urls: "stun:stun.custom.test" }], ttl: 60 };
		return new Response(JSON.stringify(body), { status: 200 });
	};
	const authenticated = new NetworkService(
		"page-secret",
		undefined,
		`${customOrigin}/`,
		base,
		(resource) => resource
	);
	assert.equal((await authenticated.auth.user()).username, "tester");
	assert.deepEqual(await authenticated.auth.relay(), {
		server: "wss://relay.custom.test",
		token: "relay-secret",
	});
	assert.equal((await authenticated.auth.peerOptions()).token, "page-secret");
	assert.deepEqual(requests, [
		{ path: "/whoami", queryToken: "page-secret", headerToken: undefined },
		{
			path: "/wisp/relay-token/create",
			queryToken: null,
			headerToken: "Bearer page-secret",
		},
		{ path: "/peer/signaller-info", queryToken: null, headerToken: undefined },
		{
			path: "/peer/generate-turn",
			queryToken: null,
			headerToken: "Bearer page-secret",
		},
	]);
	authenticated.close();
	console.log(
		"page network proxy streams fetch, WebSocket, TCP and TLS; Wisp provider shared; custom Puter API origin honored"
	);
} finally {
	globalThis.fetch = nativeFetch;
	delete globalThis.__networkMock;
	delete globalThis.__networkCall;
	fs.rmSync(mockDir, { recursive: true, force: true });
}
