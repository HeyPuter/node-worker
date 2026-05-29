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

// Each fs call is a sync XHR to puterfs, so the resolver's natural pattern of
// stat-walking node_modules dominates load time. These caches collapse repeat
// reads within a session. Module sources don't change at runtime, so we never
// invalidate.
type StatKind = "file" | "dir" | "missing";
let statCache: Map<string, StatKind> = new Map();
let readFileCache: Map<string, string> = new Map();
let packageTypeCache: Map<string, "module" | "commonjs" | undefined> = new Map();

function cachedStatKind(path: string): StatKind {
	let hit = statCache.get(path);
	if (hit !== undefined) return hit;
	let kind: StatKind;
	try {
		let stat = internalModules.fs.statSync(path);
		kind = stat.isDirectory() ? "dir" : "file";
	} catch (_e) {
		let e = _e as any;
		if (!e || (e.code !== "ENOENT" && e.code !== "ENOTDIR")) throw e;
		kind = "missing";
	}
	statCache.set(path, kind);
	return kind;
}

function cachedReadFile(path: string): string {
	let hit = readFileCache.get(path);
	if (hit !== undefined) return hit;
	let body = internalModules.fs.readFileSync(path, "utf-8") as string;
	readFileCache.set(path, body);
	return body;
}

function readPackageType(filePath: string): "module" | "commonjs" | undefined {
	let dir = internalModules.path.dirname(filePath);
	let root = internalModules.path.parse(dir).root;

	// Walk once, remembering every directory we touch so siblings hit the cache
	// on their first call.
	let visited: string[] = [];
	let result: "module" | "commonjs" | undefined;

	while (true) {
		let cached = packageTypeCache.get(dir);
		if (cached !== undefined || packageTypeCache.has(dir)) {
			result = cached;
			break;
		}
		visited.push(dir);

		let packageJsonPath = internalModules.path.join(dir, "package.json");
		if (cachedStatKind(packageJsonPath) === "file") {
			let parsed = JSON.parse(cachedReadFile(packageJsonPath));
			if (parsed && typeof parsed.type === "string") {
				if (parsed.type === "module") result = "module";
				else if (parsed.type === "commonjs") result = "commonjs";
			}
			break;
		}

		// stat-ing puter's `/` 500s, so stop one level above root.
		if (dir === root || internalModules.path.dirname(dir) === root) {
			result = undefined;
			break;
		}
		dir = internalModules.path.dirname(dir);
	}

	for (let v of visited) packageTypeCache.set(v, result);
	return result;
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

// `(target, basedir)` → resolved path. Skips the entire node_modules walk on
// repeat lookups (very common: every file in a package re-requires its peers).
let resolvePathCache: Map<string, string> = new Map();

// Overrides handed to `resolve` so its internal isFile/isDirectory/realpath/
// readFile calls share our cache. realpath is identity because puterfs has no
// symlinks (see fs/sync.ts:367), so the default realpath would just burn a
// stat per resolution.
let resolveSyncOpts = {
	isFile(file: string) {
		return cachedStatKind(file) === "file";
	},
	isDirectory(dir: string) {
		return cachedStatKind(dir) === "dir";
	},
	realpathSync(x: string) {
		return x;
	},
	readFileSync(file: string) {
		return cachedReadFile(file);
	},
	// paths: [] disables resolve's home-directory defaults
	// (~/.node_modules, ~/.node_libraries), which would call
	// path.join with a null homedir.
	paths: [] as string[],
};

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
		let cacheKey = basedir + "\0" + target;
		let cachedPath = resolvePathCache.get(cacheKey);
		if (cachedPath !== undefined) {
			path = cachedPath;
		} else {
			try {
				path = resolveSync(target, { ...resolveSyncOpts, basedir });
			} catch (e) {
				console_warn("[node-worker] [resolve] resolve failed", e);
				throw new Error(`Unknown target ${target}`, { cause: e });
			}
			resolvePathCache.set(cacheKey, path);
		}
		code = cachedReadFile(path);
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
