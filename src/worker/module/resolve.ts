// @ts-ignore
import { createRequire } from "node-core:module";
// @ts-ignore — upstream node JS, backed by our internalBinding('modules') shim
import * as packageJsonReader from "node-core:internal/modules/package_json_reader";

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

let requireCache = new Map<string, NodeJS.Require>();

function createScopedRequire(basedir: string): NodeJS.Require {
	if (requireCache.has(basedir)) return requireCache.get(basedir)!;

	let filename = internalModules.path.join(basedir, "__puter_resolve__.js");
	let req = createRequire(filename);
	requireCache.set(basedir, req);
	return req;
}

// Decide cjs vs esm the way `Module._extensions['.js']` does in upstream node:
// extension first, then the `type` field of the nearest enclosing
// package.json. Upstream's `getNearestParentPackageJSON` is backed by our
// `internalBinding('modules')` shim, which walks up via puter fs.
function detectRuntimeSourceType(filename: string): RuntimeResolvedSource["type"] {
	let ext = internalModules.path.extname(filename);
	if (ext === ".mjs") return "esm";
	if (ext === ".cjs") return "cjs";
	if (ext !== ".js") return "cjs";

	const pkg = packageJsonReader.getNearestParentPackageJSON(filename);
	return pkg?.data?.type === "module" ? "esm" : "cjs";
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
			path = createScopedRequire(basedir).resolve(target);
		} catch (e) {
			throw new Error(`Unknown target ${target}`, { cause: e });
		}
		code = internalModules.fs.readFileSync(path, "utf-8");
	}

	return {
		type: detectRuntimeSourceType(path),
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
