// A renewed Puter token reaches the Drive client and the change feed without restarting them.
import assert from "node:assert/strict";
import path from "node:path";
import { rollup } from "rollup";
import typescript from "@rollup/plugin-typescript";

const root = path.resolve(import.meta.dirname, "..");
const entry = "\0credential-test-entry";
const bundle = await rollup({
	input: "credential-test-entry",
	plugins: [
		{
			name: "credential-test-entry",
			resolveId: (id) => (id === "credential-test-entry" ? entry : null),
			load(id) {
				if (id !== entry) return null;
				const from = (file) => JSON.stringify(path.join(root, file));
				return `export { PuterCredential } from ${from("src/lib/credential.ts")};
					export { PuterApi } from ${from("src/lib/vfs/puter-http.ts")};
					export { subscribeFsEvents, retokenFsEvents } from ${from("src/lib/fsevents.ts")};`;
			},
		},
		typescript({ tsconfig: path.join(root, "tsconfig.main.json"), declaration: false }),
	],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();
const { PuterCredential, PuterApi, subscribeFsEvents, retokenFsEvents } = await import(
	`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
);

const origin = "https://api.credential.test";
const nativeFetch = globalThis.fetch;
const nativeWebSocket = globalThis.WebSocket;
const requests = [];
globalThis.fetch = async (input, init) => {
	const url = new URL(input);
	requests.push({
		path: url.pathname,
		queryToken: url.searchParams.get("auth_token"),
		headerToken: init?.headers?.Authorization,
	});
	const body = url.pathname === "/cache/last-change-timestamp" ? { timestamp: 1 } : {};
	return new Response(JSON.stringify(body), { status: 200 });
};
const sockets = [];
globalThis.WebSocket = class {
	constructor(url) {
		this.url = url;
		this.sent = [];
		sockets.push(this);
	}
	send(data) {
		this.sent.push(data);
	}
	close() {}
};
const handshake = '0{"sid":"s","pingInterval":25000,"pingTimeout":20000}';

try {
	// The Drive client reads the token per request, both ways it sends it.
	const credential = new PuterCredential("old-token");
	const api = new PuterApi(credential, origin);
	await api.fetch("stat");
	credential.set("new-token");
	await api.fetch("stat");
	await api.fetch("readdir", { path: "/" });
	assert.deepEqual(requests.splice(0), [
		{ path: "/stat", queryToken: "old-token", headerToken: undefined },
		{ path: "/stat", queryToken: "new-token", headerToken: undefined },
		{ path: "/readdir", queryToken: null, headerToken: "Bearer new-token" },
	]);

	// Ignored: empty, unchanged.
	let changes = 0;
	credential.onChange(() => changes++);
	credential.set("   ");
	credential.set("new-token");
	assert.equal(changes, 0);

	// A hub whose socket auth was rejected falls back to polling with the token it has…
	const messages = [];
	const feed = subscribeFsEvents("rejected-token", origin, (msg) => messages.push(msg));
	assert.equal(sockets.length, 1);
	sockets[0].onmessage({ data: handshake });
	assert.deepEqual(sockets[0].sent, ['40{"auth_token":"rejected-token"}']);
	sockets[0].onmessage({ data: '44{"message":"only user tokens accepted"}' });
	assert.equal(feed.connected, false);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(
		requests.splice(0).map((r) => [r.path, r.queryToken]),
		[["/cache/last-change-timestamp", "rejected-token"]]
	);

	// …and a renewal moves it to the new token and tries the socket again.
	retokenFsEvents(origin, "rejected-token", "renewed-token");
	retokenFsEvents(origin, "rejected-token", "renewed-token"); // a second holder: no-op
	assert.equal(sockets.length, 2);
	sockets[1].onmessage({ data: handshake });
	assert.deepEqual(sockets[1].sent, ['40{"auth_token":"renewed-token"}']);
	sockets[1].onmessage({ data: "40" });
	assert.equal(feed.connected, true);

	// The hub is found under its new token, so a later subscriber shares the live socket.
	const later = subscribeFsEvents("renewed-token", origin, () => {});
	assert.equal(later.connected, true);
	assert.equal(sockets.length, 2);
	// Nothing is left under the old one.
	const stale = subscribeFsEvents("rejected-token", origin, () => {});
	assert.equal(sockets.length, 3);
	stale.close();
	later.close();
	feed.close();
	console.log("renewed token reaches the Drive client and moves the change feed, reviving a rejected socket");
} finally {
	globalThis.fetch = nativeFetch;
	globalThis.WebSocket = nativeWebSocket;
}
