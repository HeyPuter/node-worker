let TOKEN: string | undefined;

export function setPuterAuth(token: string) {
	TOKEN = token;
}

export function getRandomId(): string {
	return [...Array(16)].reduce(a => a + Math.random().toString(36)[2], '')
}

export async function fetchPuter(url: string, abort?: AbortSignal, bodyInit?: Record<string, any> | ((data: FormData) => void)): Promise<Response> {
	if (!TOKEN) throw new Error("Not authed");

	if (!abort) abort = new AbortController().signal;

	let method = bodyInit ? "POST" : "GET";
	let contentType = bodyInit && !(bodyInit instanceof Function) ? "application/json" : undefined; 
	let body;
	if (bodyInit instanceof Function) {
		body = new FormData();
		bodyInit(body)
	} else {
		body = JSON.stringify(bodyInit);
	}

	return await fetch(`https://api.puter.com/${url}`, {
		headers: {
			"Authorization": `Bearer ${TOKEN}`,
			...(contentType ? { "Content-Type": contentType } : {})
		},
		method,
		body,
		signal: abort,
	})
}

export function fetchPuterSync(url: string, json?: object): Uint8Array {
	if (!TOKEN) throw new Error("Not authed");

	let xhr = new XMLHttpRequest();

	xhr.open(json ? "POST" : "GET", `https://api.puter.com/${url}`, false);
	xhr.setRequestHeader("Authorization", `Bearer ${TOKEN}`);
	if (json) xhr.setRequestHeader("Content-Type", "application/json");
	xhr.responseType = "arraybuffer";

	xhr.send(json ? JSON.stringify(json) : undefined);
	return xhr.response;
}
