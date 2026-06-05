import { setSourceMapsEnabled } from "node:process";
import { CWD, setPuterCWD } from "../state";

type Listener = { listener: (...args: any[]) => void; once: boolean };

const listeners = new Map<string, Listener[]>();
const queue: { callback: (...args: any[]) => void; args: any[] }[] = [];
let scheduled = false;

function flushNextTickQueue() {
	scheduled = false;
	while (queue.length > 0) {
		const { callback, args } = queue.shift()!;
		try {
			callback(...args);
		} catch (e) {
			queueMicrotask(() => {
				throw e;
			});
		}
	}
}

function nextTick(callback: (...args: any[]) => void, ...args: any[]) {
	if (typeof callback !== "function") {
		throw new TypeError("callback must be a function");
	}

	queue.push({ callback, args });
	if (!scheduled) {
		scheduled = true;
		queueMicrotask(flushNextTickQueue);
	}
}

function addListener(
	eventName: string,
	listener: (...args: any[]) => void,
	once: boolean
) {
	const bucket = listeners.get(eventName) ?? [];
	bucket.push({ listener, once });
	listeners.set(eventName, bucket);
	return nodeProcess;
}

const nodeProcess: any = {
	env: { TERM: "xterm-256color" },
	platform: "browser",
	arch: "wasm",
	pid: 1,
	ppid: 0,
	argv: ["node"],
	argv0: "node",
	execPath: "node",
	execArgv: [],
	version: "25.6.1",
	versions: {
		node: "25.6.1",
	},
	features: {
		require_module: false,
		cached_builtins: true,
		debug: false,
		inspector: false,
		ipv6: true, // false
		tls: false, // TODO
		tls_alpn: false, // TODO
		tls_ocsp: false, // TODO
		tls_sni: false, // TODO
		typescript: false,
		uv: true, // false
		// We back crypto with OpenSSL (not BoringSSL); internal/crypto/util.js
		// branches on this when deciding which WebCrypto algorithms are gated.
		openssl_is_boringssl: false
	},
	// process is `inject`-ed into upstream node-core, so importing ../console
	// here would form a cycle through node/stream's wrapper. console.ts assigns
	// stdin/stdout/stderr in `initConsole`.
	stdin: undefined as any,
	stdout: undefined as any,
	stderr: undefined as any,
	cwd() {
		return CWD;
	},
	chdir(dir: string) {
		// TODO ?
		setPuterCWD(dir);
	},
	nextTick,
	emitWarning(message: any, type: string = "Warning") {
		if (typeof console !== "undefined" && typeof console.warn === "function") {
			console.warn(`${type}: ${message}`);
		}
	},
	on(eventName: string, listener: (...args: any[]) => void) {
		return addListener(eventName, listener, false);
	},
	once(eventName: string, listener: (...args: any[]) => void) {
		return addListener(eventName, listener, true);
	},
	off(eventName: string, listener: (...args: any[]) => void) {
		const bucket = listeners.get(eventName);
		if (!bucket) return nodeProcess;
		listeners.set(
			eventName,
			bucket.filter((entry) => entry.listener !== listener)
		);
		return nodeProcess;
	},
	addListener(eventName: string, listener: (...args: any[]) => void) {
		return addListener(eventName, listener, false);
	},
	removeListener(eventName: string, listener: (...args: any[]) => void) {
		const bucket = listeners.get(eventName);
		if (!bucket) return nodeProcess;
		listeners.set(
			eventName,
			bucket.filter((entry) => entry.listener !== listener)
		);
		return nodeProcess;
	},
	removeAllListeners(eventName?: string) {
		if (eventName) listeners.delete(eventName);
		else listeners.clear();
		return nodeProcess;
	},
	listeners(eventName: string) {
		return (listeners.get(eventName) ?? []).map((entry) => entry.listener);
	},
	listenerCount(eventName: string) {
		return (listeners.get(eventName) ?? []).length;
	},
	emit(eventName: string, ...args: any[]) {
		const bucket = listeners.get(eventName);
		if (!bucket || bucket.length === 0) return false;

		for (const entry of [...bucket]) {
			try {
				entry.listener(...args);
			} catch (e) {
				queueMicrotask(() => {
					throw e;
				});
			}
			if (entry.once) {
				nodeProcess.removeListener(eventName, entry.listener);
			}
		}

		return true;
	},
	kill() {
		return false;
	},
	exit(_code?: number) {
		throw new Error("process.exit is not supported");
	},
	hrtime: Object.assign(
		(time?: [number, number]): [number, number] => {
			const now = performance.now() * 1e6;
			const seconds = Math.floor(now / 1e9);
			const nanos = Math.floor(now % 1e9);
			if (time) {
				return [seconds - time[0], nanos - time[1]];
			}
			return [seconds, nanos];
		},
		{
			bigint(): bigint {
				return BigInt(Math.floor(performance.now() * 1e6));
			},
		}
	),
	uptime() {
		return performance.now() / 1000;
	},
	binding() {
		throw new Error("process.binding is not supported");
	},
	setSourceMapsEnabled() {}
};

(globalThis as any).process = nodeProcess;

export default nodeProcess as typeof import("node:process");
