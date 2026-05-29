import { parse } from "acorn";
import { sync as resolveSync } from "resolve";

import internalModules from "../node";
import { console_warn } from "../console";

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

function readPackageType(filePath: string): "module" | "commonjs" | undefined {
	let dir = internalModules.path.dirname(filePath);
	let root = internalModules.path.parse(dir).root;

	while (true) {
		let packageJsonPath = internalModules.path.join(dir, "package.json");
		try {
			let stat = internalModules.fs.statSync(packageJsonPath);
			if (stat.isFile()) {
				let parsed = JSON.parse(
					internalModules.fs.readFileSync(packageJsonPath, "utf-8") as string
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

		// stat-ing puter's `/` 500s, so stop one level above root.
		if (dir === root || internalModules.path.dirname(dir) === root) return undefined;
		dir = internalModules.path.dirname(dir);
	}
}

function hasEsmOnlySyntax(code: string): boolean {
	let scriptErrPos = -1;
	try {
		parse(code, { ecmaVersion: 2026, sourceType: "script" });
		return false;
	} catch (e) {
		scriptErrPos = (e as any)?.pos ?? -1;
	}
	try {
		parse(code, { ecmaVersion: 2026, sourceType: "module" });
		return true;
	} catch (e) {
		// Both parses failed. If module-mode got further than script-mode, the
		// script-mode failure was likely an ESM-only construct (import/export,
		// top-level await) that the actual syntax error sits past.
		let moduleErrPos = (e as any)?.pos ?? -1;
		return moduleErrPos > scriptErrPos;
	}
}

// Decide cjs vs esm the way `Module._extensions['.js']` does in upstream node:
// extension first, then the `type` field of the nearest enclosing
// package.json. Falls back to syntax sniffing for ambiguous `.js` files
// (and virtual sources with unknown/missing extensions) without a
// package.json.
function detectRuntimeSourceType(source: {
	path: string;
	code: string;
}): RuntimeResolvedSource["type"] {
	let ext = internalModules.path.extname(source.path);
	if (ext === ".mjs") return "esm";
	if (ext === ".cjs") return "cjs";

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
			// paths: [] disables resolve's home-directory defaults
			// (~/.node_modules, ~/.node_libraries), which would call
			// path.join with a null homedir.
			path = resolveSync(target, { basedir, paths: [] });
		} catch (e) {
			console_warn("[node-worker] [resolve] resolve failed", e);
			throw new Error(`Unknown target ${target}`, { cause: e });
		}
		code = internalModules.fs.readFileSync(path, "utf-8");
	}

	return {
		type: detectRuntimeSourceType({ path, code }),
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
