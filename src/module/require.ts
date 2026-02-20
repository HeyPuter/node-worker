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

	try {
		let source = internalModules.fs.readFileSync(resolvedTarget, "utf-8");
		return runCode(source, resolvedTarget, false);
	} catch (e) {
		throw new Error(`Failed to load module from "${resolvedTarget}"`, {
			cause: e,
		});
	}
}

export function createRequire(basedir: string): (target: string) => any {
	return (target: string) => requireWithBasedir(target, basedir);
}

export function require(target: string): any {
	return requireWithBasedir(target, CWD);
}
