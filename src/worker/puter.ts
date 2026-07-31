import { FETCH } from "./epoxy";
import { PUTER_TOKEN } from "./state";
import * as keepalive from "./keepalive";
import { console_error } from "./console";

export let API_ORIGIN = "https://api.puter.com";

export function getRandomId(): string {
	return [...Array(16)].reduce((a) => a + Math.random().toString(36)[2], "");
}

let decoder = new TextDecoder("utf-8");

export function decode(buf: Uint8Array): any {
	return JSON.parse(decoder.decode(buf));
}

function handleBody(bodyInit?: PuterBodyInit): string | FormData | undefined {
	if (!bodyInit) return;
	let body;
	if (bodyInit instanceof Function) {
		body = new FormData();
		bodyInit(body);
	} else {
		body = JSON.stringify(bodyInit);
	}
	return body;
}

function handleBodySettings(bodyInit?: PuterBodyInit): [string, Record<string, string>] {
	let method = bodyInit ? "POST" : "GET";
	let headers = bodyInit && !(bodyInit instanceof Function) ? { "Content-Type": "application/json" } : {};

	return [method, headers as Record<string, string>];
}

function handleAuth(
	path: string,
	method: string,
	token: string,
	headers: Record<string, string>
): string {
	let url = new URL(`${API_ORIGIN}/${path}`);
	// A GET with no custom request headers is a CORS-*simple* request, so the
	// browser skips the preflight OPTIONS entirely. Carrying the token as
	// `?auth_token=` instead of an `Authorization` header is what keeps it simple
	// (the api accepts either — see the backend's authProbe middleware), and it
	// halves the round trips on the sync path, where every preflight blocks the
	// worker thread. POSTs always send `Content-Type: application/json`, which
	// preflights no matter what we do with the token, so they keep the header.
	if (method === "GET") {
		url.searchParams.append("auth_token", token);
	} else {
		headers["Authorization"] = "Bearer " + token;
	}
	return url.toString();
}

// Per-endpoint call counts, keyed by the path with the query string stripped
// ("stat", "fs/readdir", "read", ...). The whole point of the resolver and
// readdir work is to make this number go down, and there is no other way to see
// it: dumped after each `execute` when NODE_WORKER_API_STATS is set.
let requestCounts: Map<string, number> = new Map();

function countRequest(path: string) {
	let key = path.split("?")[0];
	requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
}

export function getRequestStats(): Record<string, number> {
	return Object.fromEntries([...requestCounts].sort((a, b) => b[1] - a[1]));
}

export function resetRequestStats() {
	requestCounts.clear();
}

/**
 * Report the per-endpoint counts, to both places they're useful.
 *
 * `console_error` is bound to the *worker's* native console (see console.ts), so it
 * lands in devtools — convenient interactively, where the object expands, but
 * devtools renders a logged object as "[object Object]" to anything reading the
 * console programmatically. So a pre-serialized copy also goes to the program's own
 * stderr, which is where the rest of its output goes and the only form a harness can
 * actually read.
 *
 * This lives here rather than at the call site in index.ts for the same reason
 * `apiStatsEnabled` does: mentioning `process` in the entry module makes rollup's
 * inject plugin prepend an import for it *above* `import "./early-import"`, which
 * hoists the whole node subgraph ahead of the primordials bootstrap and leaves
 * `SymbolFor` undefined for everything that reads it during init.
 */
export function reportRequestStats() {
	let counts = getRequestStats();
	let total = Object.values(counts).reduce((a, b) => a + b, 0);
	console_error("[node-worker] api calls", counts);
	process.stderr.write(
		`[node-worker] api calls total=${total} ${JSON.stringify(counts)}\n`
	);
}

// Deliberately reads `process` *here* rather than at the call site in
// index.ts. Rollup's inject plugin turns a free `process` into an import
// prepended to the top of whichever module mentions it, and node/process.ts
// sits in the events/stream/fs cycle — so mentioning it in the entry module
// hoists that whole subgraph ahead of `import "./early-import"` and primordials
// ends up initialized after the modules that read it.
export function apiStatsEnabled(): boolean {
	return !!process.env.NODE_WORKER_API_STATS;
}

export type PuterBodyInit = Record<string, any> | ((data: FormData) => void);

// Extra request headers, merged over the ones the body/auth handling picks.
// Only `Range` uses this today; note that any custom header on a GET costs a
// CORS preflight (see `handleAuth`), so it's worth avoiding on hot paths.
export type PuterHeaders = Record<string, string>;

export async function fetchPuter(
	url: string,
	bodyInit?: PuterBodyInit,
	abort?: AbortSignal,
	extraHeaders?: PuterHeaders
): Promise<[boolean, Uint8Array, Response]> {
	if (!PUTER_TOKEN) throw new Error("Not authed");

	if (!abort) abort = new AbortController().signal;

	let [method, headers] = handleBodySettings(bodyInit);
	if (extraHeaders) Object.assign(headers, extraHeaders);
	countRequest(url);

	// A puter API call is this runtime's equivalent of a libuv fs/network request:
	// node would hold a refed handle open for its whole duration, so the worker
	// has to stay alive across the round trip — headers *and* body read.
	//
	// This must ref explicitly rather than lean on the keepalive-wrapping proxy
	// installed over `globalThis.fetch` (epoxy/globals.ts), because `FETCH` is the
	// pre-proxy native snapshot. Every async `fs` operation funnels through here
	// (node/fs/promises.ts, node/fs/handle.ts), so without this a program whose
	// only pending work is an fs promise reads as zero active handles and drain()
	// settles the run out from under it.
	keepalive.ref();
	try {
		let res = await FETCH(handleAuth(url, method, PUTER_TOKEN, headers), {
			headers,
			method,
			body: handleBody(bodyInit),
			signal: abort,
		});

		return [res.ok, new Uint8Array(await res.arrayBuffer()), res];
	} finally {
		keepalive.unref();
	}
}

// Like `fetchPuter`, but hands back the un-consumed `Response` so the caller can
// read the body incrementally. `createReadStream` uses this to serve a whole
// file from one request instead of a ranged GET per chunk.
//
// The keepalive ref is held until the body ends rather than until the headers
// arrive: the read isn't finished when this resolves, and the run must not drain
// out from under a stream that's still pumping. (This is the gap the comment on
// `fetchPuter` describes; anything that streams a response should come through
// here.) `release` is idempotent and MUST be called by the consumer if it
// abandons the body without reading to the end.
export async function fetchPuterStream(
	url: string,
	abort?: AbortSignal,
	extraHeaders?: PuterHeaders
): Promise<[ok: boolean, res: Response, release: () => void]> {
	if (!PUTER_TOKEN) throw new Error("Not authed");

	if (!abort) abort = new AbortController().signal;

	let [method, headers] = handleBodySettings(undefined);
	if (extraHeaders) Object.assign(headers, extraHeaders);
	countRequest(url);

	keepalive.ref();
	let released = false;
	let release = () => {
		if (released) return;
		released = true;
		keepalive.unref();
	};

	try {
		let res = await FETCH(handleAuth(url, method, PUTER_TOKEN, headers), {
			headers,
			method,
			signal: abort,
		});
		return [res.ok, res, release];
	} catch (err) {
		release();
		throw err;
	}
}

export interface PuterUser {
	username: string;
	uuid: string;
	email: string;
}

export let PUTER_USER: PuterUser = {
	username: "NOT_INITIALIZED",
	uuid: "NOT_INITIALIZED",
	email: "NOT_INITIALIZED",
};

export async function fetchUserInfo(): Promise<PuterUser> {
	let [ok, u8array] = await fetchPuter("whoami");
	if (!ok) throw new Error("failed to fetch user info");
	let parsed = decode(u8array) as PuterUser;
	PUTER_USER = parsed;
	process.env.HOME = `/${parsed.username}`;
	return parsed;
}

// A transport-level failure — DNS, connection refused, CORS rejection. A blocking
// XHR reports these by throwing a `NetworkError` DOMException out of `send()`, which
// would otherwise escape the fs layer as something with no `code` at all and defeat
// every `catch (e) { if (e.code !== ... ) throw e }` above it.
//
// Only `code`/`errno` are set here. `syscall` and `path` belong to whoever knows
// which operation was running, which the driver does and this does not; it decorates
// the error on the way out.
function syncNetworkError(cause: unknown): NodeJS.ErrnoException {
	let err = new Error("EIO: i/o error", { cause }) as NodeJS.ErrnoException;
	err.code = "EIO";
	err.errno = -5;
	return err;
}

export function fetchPuterSync(
	url: string,
	bodyInit?: PuterBodyInit,
	extraHeaders?: PuterHeaders
): [ok: boolean, body: Uint8Array, status: number] {
	if (!PUTER_TOKEN) throw new Error("Not authed");

	let xhr = new XMLHttpRequest();

	let [method, headers] = handleBodySettings(bodyInit);
	if (extraHeaders) Object.assign(headers, extraHeaders);
	countRequest(url);

	xhr.open(method, handleAuth(url, method, PUTER_TOKEN, headers), false);
	for (let header in headers) {
		xhr.setRequestHeader(header, headers[header]);
	}
	xhr.responseType = "arraybuffer";

	try {
		xhr.send(handleBody(bodyInit));
	} catch (err) {
		throw syncNetworkError(err);
	}

	// `responseType = "arraybuffer"` means `xhr.response` is an ArrayBuffer, not a
	// Uint8Array — this used to be returned as-is under a `Uint8Array` annotation.
	// `decode()` and `Buffer.from()` both tolerate either, which is why it went
	// unnoticed, but `.subarray()` does not exist on an ArrayBuffer: the moment a
	// caller sends a `Range` on this path and hits the "server ignored it" fallback,
	// it throws. Wrap once, here.
	//
	// `?? 0` covers the aborted/failed case, where `response` is null.
	let body = new Uint8Array(xhr.response ?? 0);

	// The whole 2xx range, not `status / 100 === 2` — that arithmetic is only true
	// for exactly 200 (206/100 is 2.06), so every other success code read as a
	// failure. It went unnoticed because until ranged reads reached the sync path
	// nothing here answered with one; a 206 from a `Range` request then failed with
	// the body parsed as an error. `fetchPuter` never had the bug: it uses fetch's
	// own `res.ok`, which is 200-299, so the two transports silently disagreed.
	//
	// The status is also returned rather than folded into `ok`, because a 416 (range
	// past EOF) and a 500 are both "not 2xx" and callers must tell them apart.
	let ok = xhr.status >= 200 && xhr.status < 300;
	return [ok, body, xhr.status];
}
