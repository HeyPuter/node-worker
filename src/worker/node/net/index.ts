import { Socket } from "./socket";

type NodeNet = typeof import("node:net");

let autoSelectFamily = true;
let autoSelectFamilyAttemptTimeout = 250;

export default {
	Socket,
	connect(...args: any[]) {
		let socket = new Socket() as any;
		return socket.connect(...args);
	},
	createConnection(...args: any[]) { (this as any).connect(...args); },
	isIP(input) {
		if (this.isIPv4(input)) return 4;
		if (this.isIPv6(input)) return 6;
		return 0;
	},
	isIPv4(input) {
		let parts = input.split(".");
		if (parts.length !== 4) return false;

		for (let part of parts) {
			if (!/^\d+$/.test(part)) return false;
			if (part.length > 1 && part.startsWith("0")) return false;

			let n = Number(part);
			if (!Number.isInteger(n) || n < 0 || n > 255) return false;
		}

		return true;
	},
	isIPv6(input) {
		if (!input.includes(":")) return false;
		if ((input.match(/::/g) || []).length > 1) return false;

		let chunks = input.split(":");
		if (input.includes("::")) {
			if (chunks.length > 8) return false;
		} else if (chunks.length !== 8) {
			return false;
		}

		for (let chunk of chunks) {
			if (!chunk.length) continue;
			if (chunk.length > 4) return false;
			if (!/^[\da-fA-F]+$/.test(chunk)) return false;
		}

		return true;
	},
	getDefaultAutoSelectFamily() {
		return autoSelectFamily;
	},
	setDefaultAutoSelectFamily(value: boolean) {
		autoSelectFamily = !!value;
	},
	getDefaultAutoSelectFamilyAttemptTimeout() {
		return autoSelectFamilyAttemptTimeout;
	},
	setDefaultAutoSelectFamilyAttemptTimeout(value: number) {
		autoSelectFamilyAttemptTimeout = Math.max(10, Number(value) || 10);
	},
} satisfies NodeNet;
