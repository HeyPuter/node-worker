import { FETCH } from "./epoxy";
import { PUTER_TOKEN } from "./state";

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

export type PuterBodyInit = Record<string, any> | ((data: FormData) => void);
export async function fetchPuter(
	url: string,
	bodyInit?: PuterBodyInit,
	abort?: AbortSignal
): Promise<[boolean, Uint8Array]> {
	if (!PUTER_TOKEN) throw new Error("Not authed");

	if (!abort) abort = new AbortController().signal;

	let method = bodyInit ? "POST" : "GET";
	let contentType =
		bodyInit && !(bodyInit instanceof Function)
			? "application/json"
			: undefined;

	let res = await FETCH(`https://api.puter.com/${url}`, {
		headers: {
			Authorization: `Bearer ${PUTER_TOKEN}`,
			...(contentType ? { "Content-Type": contentType } : {}),
		},
		method,
		body: handleBody(bodyInit),
		signal: abort,
	});

	return [res.ok, new Uint8Array(await res.arrayBuffer())];
}

export function fetchPuterSync(
	url: string,
	bodyInit?: PuterBodyInit
): [boolean, Uint8Array] {
	if (!PUTER_TOKEN) throw new Error("Not authed");

	let xhr = new XMLHttpRequest();

	xhr.open(bodyInit ? "POST" : "GET", `https://api.puter.com/${url}`, false);
	xhr.setRequestHeader("Authorization", `Bearer ${PUTER_TOKEN}`);
	if (bodyInit && !(bodyInit instanceof Function))
		xhr.setRequestHeader("Content-Type", "application/json");
	xhr.responseType = "arraybuffer";

	xhr.send(handleBody(bodyInit));
	return [xhr.status / 100 === 2, xhr.response];
}
