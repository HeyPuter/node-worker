import { parse } from "acorn";
import { sync as resolveSync, SyncOpts } from "resolve";

import internalModules from "../node";

export type ResolvedSourceType = "esm" | "cjs" | "internal";

export interface BaseResolvedSource {
	type: ResolvedSourceType;
	id: string;
}

export interface RuntimeResolvedSource extends BaseResolvedSource {
	type: "esm" | "cjs";
	path: string;
	dir: string;
	code: string;
}

export interface InternalResolvedSource extends BaseResolvedSource {
	type: "internal";
	module: string;
	exports: any;
}

export type ResolvedSource = RuntimeResolvedSource | InternalResolvedSource;

let resolveOpts: SyncOpts = {
	includeCoreModules: false,
	extensions: [".js"],
	readFileSync(file) {
		return internalModules.fs.readFileSync(file);
	},
	isFile(file) {
		try {
			var stat = internalModules.fs.statSync(file);
		} catch (_e) {
			let e: any = _e;
			if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return false;
			throw e;
		}
		return stat.isFile() || stat.isFIFO();
	},
	isDirectory(dir) {
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
		return file;
	},
};

function readPackageType(filePath: string): "module" | "commonjs" | undefined {
	let dir = internalModules.path.dirname(filePath);
	let root = internalModules.path.parse(dir).root;

	while (true) {
		let packageJsonPath = internalModules.path.join(dir, "package.json");
		try {
			let stat = internalModules.fs.statSync(packageJsonPath);
			if (stat.isFile()) {
				let parsed = JSON.parse(
					internalModules.fs.readFileSync(packageJsonPath, "utf-8")
				);
				if (parsed && typeof parsed.type === "string") {
					if (parsed.type === "module") return "module";
					if (parsed.type === "commonjs") return "commonjs";
				}
				return undefined;
			}
		} catch (_e) {
			let e = _e as any;
			if (!e || (e.code !== "ENOENT" && e.code !== "ENOTDIR")) {
				throw e;
			}
		}

		if (dir === root) return undefined;
		dir = internalModules.path.dirname(dir);
	}
}

function hasEsmOnlySyntax(code: string): boolean {
	try {
		parse(code, { ecmaVersion: 2026, sourceType: "script" });
		return false;
	} catch {
		try {
			parse(code, { ecmaVersion: 2026, sourceType: "module" });
			return true;
		} catch {
			return false;
		}
	}
}

function detectRuntimeSourceType(source: {
	path: string;
	code: string;
}): RuntimeResolvedSource["type"] {
	let ext = internalModules.path.extname(source.path);

	if (ext === ".mjs") return "esm";
	if (ext === ".cjs") return "cjs";
	if (ext !== ".js") return "cjs";

	let packageType = readPackageType(source.path);
	if (packageType === "module") return "esm";
	if (packageType === "commonjs") return "cjs";

	return hasEsmOnlySyntax(source.code) ? "esm" : "cjs";
}

let customSources: Map<string, string> = new Map();

export function resolveSource(target: string, basedir: string): ResolvedSource {
	if (target.startsWith("node:")) {
		target = target.slice("node:".length);
		if (Object.hasOwn(internalModules, target)) {
			return {
				type: "internal",
				id: target,
				module: target,
				exports: (internalModules as any)[target],
			};
		}
		throw new Error(`Unknown internal module "node:${target}"`);
	}

	if (Object.hasOwn(internalModules, target)) {
		return {
			type: "internal",
			id: target,
			module: target,
			exports: (internalModules as any)[target],
		};
	}

	let path: string, code: string;
	if (customSources.has(target)) {
		path = target;
		code = customSources.get(target)!;
	} else {
		try {
			path = resolveSync(target, { ...resolveOpts, basedir });
		} catch (e) {
			throw new Error(`Unknown target ${target}`, { cause: e });
		}
		code = internalModules.fs.readFileSync(path, "utf-8");
	}

	let type = detectRuntimeSourceType({ code, path: path });

	return {
		type,
		id: path,
		dir: internalModules.path.dirname(path),
		path,
		code,
	};
}

export function registerVirtualSource(path: string, code: string) {
	internalModules.path.parse(path);
	customSources.set(path, code);
}
export function deregisterVirtualSource(path: string) {
	internalModules.path.parse(path);
	customSources.delete(path);
}
