
let token: string | undefined;

export async function fetchPuter(url: string, json?: object): Promise<Response> {
	if (!token) throw new Error("Not authed");

	return await fetch(`https://api.puter.com/${url}`, {
		headers: {
			"Authorization": `Bearer ${token}`,
			...(json ? { "Content-Type": "application/json" } : {}),
		},
		method: json ? "POST" : "GET",
		...(json ? {
			body: JSON.stringify(json),
		} : {})
	})
}
export function fetchPuterSync(url: string, json?: object): Uint8Array {
	if (!token) throw new Error("Not authed");

	let xhr = new XMLHttpRequest();

	xhr.open(json ? "POST" : "GET", `https://api.puter.com/${url}`, false);
	xhr.setRequestHeader("Authorization", `Bearer ${token}`);
	if (json) xhr.setRequestHeader("Content-Type", "application/json");
	xhr.responseType = "arraybuffer";

	xhr.send(json ? JSON.stringify(json) : undefined);
	return xhr.response;
}
