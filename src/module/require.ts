import { sync as resolveSync, SyncOpts } from "resolve";

import internalModules from "../node";
import { CWD } from "../state";
import { runCode } from ".";

let resolveOpts: SyncOpts = {
	includeCoreModules: false,
	extensions: [".js"],
	readFileSync(file) {
		return internalModules.fs.readFileSync(file);
	},
	isFile: function isFile(file) {
		try {
			var stat = internalModules.fs.statSync(file);
		} catch (_e) {
			let e: any = _e;
			if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return false;
			throw e;
		}
		return stat.isFile() || stat.isFIFO();
	},
	isDirectory: function isDirectory(dir) {
		try {
			var stat = internalModules.fs.statSync(dir);
		} catch (_e) {
			let e: any = _e;
			if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return false;
			throw e;
		}
		return stat.isDirectory();
	},
	realpathSync(file) {
		// TODO
		return file;
	},
};

let REQUIRE_CACHE: Record<string, any> = {};

function requireWithBasedir(target: string, basedir: string): any {
	if (target.startsWith("node:")) {
		target = target.slice("node:".length);
		if (Object.hasOwn(internalModules, target)) {
			return (internalModules as any)[target];
		}
		throw new Error(`Unknown internal module "node:${target}"`);
	}

	if (Object.hasOwn(internalModules, target)) {
		return (internalModules as any)[target];
	}

	let resolvedTarget: string;
	try {
		resolvedTarget = resolveSync(target, { ...resolveOpts, basedir });
	} catch (e) {
		throw new Error(`Unknown target ${target}`, { cause: e });
	}

	if (Object.hasOwn(REQUIRE_CACHE, resolvedTarget)) {
		return REQUIRE_CACHE[resolvedTarget];
	}

	try {
		let source = internalModules.fs.readFileSync(resolvedTarget, "utf-8");
		let exports = runCode(source, resolvedTarget, false);
		REQUIRE_CACHE[resolvedTarget] = exports;
		return exports;
	} catch (e) {
		throw new Error(`Failed to load module from "${resolvedTarget}"`, {
			cause: e,
		});
	}
}

interface RequireFn {
	(target: string): any;
	cache: Record<string, any>;
}

export function createRequire(basedir: string): RequireFn {
	let fn: RequireFn = ((target: string) => requireWithBasedir(target, basedir)) as any;
	fn.cache = REQUIRE_CACHE;
	return fn;
}

export function require(target: string): any {
	return requireWithBasedir(target, CWD);
}
