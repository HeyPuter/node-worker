import { FETCH } from "./epoxy";
import { PUTER_TOKEN } from "./state";

let API_ORIGIN = "https://api.puter.com";

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
	token: string,
	headers: Record<string, string>
): string {
	let url = new URL(`${API_ORIGIN}/${path}`);
	// TODO make this more robust, this skips preflights for read
	if (path.startsWith("read")) {
		url.searchParams.append("auth_token", token);
	} else {
		headers["Authorization"] = "Bearer " + token;
	}
	return url.toString();
}

export type PuterBodyInit = Record<string, any> | ((data: FormData) => void);
export async function fetchPuter(
	url: string,
	bodyInit?: PuterBodyInit,
	abort?: AbortSignal
): Promise<[boolean, Uint8Array]> {
	if (!PUTER_TOKEN) throw new Error("Not authed");

	if (!abort) abort = new AbortController().signal;

	let [method, headers] = handleBodySettings(bodyInit);

	let res = await FETCH(handleAuth(url, PUTER_TOKEN, headers), {
		headers,
		method,
		body: handleBody(bodyInit),
		signal: abort,
	});

	return [res.ok, new Uint8Array(await res.arrayBuffer())];
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

export function fetchPuterSync(
	url: string,
	bodyInit?: PuterBodyInit
): [boolean, Uint8Array] {
	if (!PUTER_TOKEN) throw new Error("Not authed");

	let xhr = new XMLHttpRequest();

	let [method, headers] = handleBodySettings(bodyInit);

	xhr.open(method, handleAuth(url, PUTER_TOKEN, headers), false);
	for (let header in headers) {
		xhr.setRequestHeader(header, headers[header]);
	}
	xhr.responseType = "arraybuffer";

	xhr.send(handleBody(bodyInit));
	return [xhr.status / 100 === 2, xhr.response];
}
