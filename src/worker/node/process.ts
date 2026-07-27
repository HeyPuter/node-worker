import { CWD, setPuterCWD } from "../state";
import nodeEvents from "./events";
import { holder as asyncContextHolder } from "../node-core/internal-binding/async_context_frame";

const queue: {
	callback: (...args: any[]) => void;
	args: any[];
	frame: any;
}[] = [];
let scheduled = false;

function flushNextTickQueue() {
	scheduled = false;
	while (queue.length > 0) {
		const { callback, args, frame } = queue.shift()!;
		// Run each tick under the async context frame that was current when it was
		// scheduled, matching how V8 would preserve continuation data for nextTick.
		const prev = asyncContextHolder.frame;
		asyncContextHolder.frame = frame;
		try {
			callback(...args);
		} catch (e) {
			queueMicrotask(() => {
				throw e;
			});
		} finally {
			asyncContextHolder.frame = prev;
		}
	}
}

// Synchronously drain the nextTick queue. Upstream internal/timers.js calls
// this (as `runNextTicks`) between timer/immediate callbacks so ticks queued by
// one callback run before the next one, matching node's ordering.
export function runNextTicks() {
	flushNextTickQueue();
}

function nextTick(callback: (...args: any[]) => void, ...args: any[]) {
	if (typeof callback !== "function") {
		throw new TypeError("callback must be a function");
	}

	queue.push({ callback, args, frame: asyncContextHolder.frame });
	if (!scheduled) {
		scheduled = true;
		queueMicrotask(flushNextTickQueue);
	}
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

Object.setPrototypeOf(nodeProcess, nodeEvents.EventEmitter.prototype);
(nodeEvents.EventEmitter as any).call(nodeProcess);

(globalThis as any).process = nodeProcess;

export default nodeProcess as typeof import("node:process");
