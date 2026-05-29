import { PUTER_USER } from "../puter";

function unsupported(name: string) {
	return () => {
		throw new Error(`node:os.${name} is not supported in this runtime`);
	};
}

const EOL = "\n";

const constants = {
	UV_UDP_REUSEADDR: 4,
	dlopen: {},
	errno: {},
	signals: {},
	priority: {},
};

const devNull = "/dev/null";

function platform() {
	return "browser" as NodeJS.Platform;
}

function type() {
	return "Browser";
}

function release() {
	return "0.0.0";
}

function version() {
	return "";
}

function arch() {
	return "wasm";
}

function endianness(): "BE" | "LE" {
	const buf = new ArrayBuffer(2);
	new DataView(buf).setInt16(0, 256, true);
	return new Int16Array(buf)[0] === 256 ? "LE" : "BE";
}

function hostname() {
	return "puter";
}

function username(): string {
	return PUTER_USER.username;
}

function homedir(): string {
	return `/${username()}`;
}

function tmpdir() {
	return "/tmp";
}

function uptime() {
	return performance.now() / 1000;
}

function freemem() {
	return 0;
}

function totalmem() {
	return 0;
}

function loadavg() {
	return [0, 0, 0];
}

function cpus() {
	const count =
		typeof navigator !== "undefined" &&
		typeof navigator.hardwareConcurrency === "number"
			? navigator.hardwareConcurrency
			: 1;
	const result = [];
	for (let i = 0; i < count; i++) {
		result.push({
			model: "unknown",
			speed: 0,
			times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
		});
	}
	return result;
}

function availableParallelism() {
	if (
		typeof navigator !== "undefined" &&
		typeof navigator.hardwareConcurrency === "number"
	) {
		return navigator.hardwareConcurrency;
	}
	return 1;
}

function networkInterfaces() {
	return {};
}

function userInfo(_options?: any) {
	return {
		uid: -1,
		gid: -1,
		username: username(),
		homedir: homedir(),
		shell: null,
	};
}

function machine() {
	return "wasm";
}

const os = {
	EOL,
	constants,
	devNull,
	platform,
	type,
	release,
	version,
	arch,
	endianness,
	hostname,
	homedir,
	tmpdir,
	uptime,
	freemem,
	totalmem,
	loadavg,
	cpus,
	availableParallelism,
	networkInterfaces,
	userInfo,
	machine,
	getPriority: unsupported("getPriority"),
	setPriority: unsupported("setPriority"),
};

export default os as unknown as typeof import("node:os");
