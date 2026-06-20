import { parse } from "acorn";
import { sync as resolveSync } from "resolve";
import { exports as exportsResolve, imports as importsResolve } from "resolve.exports";

import internalModules from "../node";
import { console_warn } from "../console";

export type ResolveCondition = "import" | "require";

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
		let parent = internalModules.path.dirname(dir);
		if (dir === root || parent === root || parent === dir) {
			result = undefined;
			break;
		}
		dir = parent;
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

// `(condition, basedir, target)` → resolved path. Skips the entire node_modules
// walk on repeat lookups (very common: every file in a package re-requires its
// peers). Condition is part of the key because exports/imports can map the
// same specifier to different files under `import` vs `require`.
let resolvePathCache: Map<string, string> = new Map();

// Split a bare specifier into its package name and the requested subpath.
// "ws" → { pkgName: "ws", subpath: "." }
// "ws/lib/foo" → { pkgName: "ws", subpath: "./lib/foo" }
// "@scope/pkg/sub" → { pkgName: "@scope/pkg", subpath: "./sub" }
function splitBareSpecifier(target: string): { pkgName: string; subpath: string } {
	let parts = target.split("/");
	let pkgEnd = target.startsWith("@") ? 2 : 1;
	let pkgName = parts.slice(0, pkgEnd).join("/");
	let rest = parts.slice(pkgEnd).join("/");
	return { pkgName, subpath: rest ? `./${rest}` : "." };
}

// Walk up from basedir looking for `<dir>/node_modules/<pkgName>/package.json`
// (the standard node_modules resolution algorithm). Returns the package.json
// path or null.
function findPackageJson(pkgName: string, basedir: string): string | null {
	let dir = basedir;
	let root = internalModules.path.parse(dir).root;
	while (true) {
		let candidate = internalModules.path.join(
			dir,
			"node_modules",
			pkgName,
			"package.json"
		);
		if (cachedStatKind(candidate) === "file") return candidate;
		// stat-ing puter's `/` 500s, so stop one level above root. `parent === dir`
		// is the fixed-point guard: a non-absolute basedir (e.g. a stray `file://`
		// URL) has no POSIX root, so dirname converges to "." instead of `root` —
		// without this the walk would spin forever.
		let parent = internalModules.path.dirname(dir);
		if (dir === root || parent === root || parent === dir) return null;
		dir = parent;
	}
}

// Resolve a bare specifier via the package's `exports` (or `imports` for
// `#`-prefixed specifiers) field, honoring the caller's condition. Returns
// the resolved absolute file path, or null if the package has no exports
// field or the specifier doesn't match. Throws if exports is present but
// the subpath is explicitly not exported.
function resolveViaExportsField(
	target: string,
	basedir: string,
	condition: ResolveCondition
): string | null {
	// Imports field (`#foo`) is resolved relative to the importer's nearest
	// package.json, not via node_modules walking.
	if (target.startsWith("#")) {
		let dir = basedir;
		let root = internalModules.path.parse(dir).root;
		while (true) {
			let pjsonPath = internalModules.path.join(dir, "package.json");
			if (cachedStatKind(pjsonPath) === "file") {
				let pkg = JSON.parse(cachedReadFile(pjsonPath));
				if (pkg && pkg.imports) {
					let matched = importsResolve(pkg, target, {
						conditions: ["node"],
						require: condition === "require",
					});
					if (matched && matched.length > 0) {
						let pkgDir = internalModules.path.dirname(pjsonPath);
						let first = matched[0];
						if (first.startsWith(".")) {
							return internalModules.path.join(pkgDir, first);
						}
						// Imports can map to an external package; recurse via
						// the normal resolver against that package.
						return null;
					}
				}
				return null;
			}
			let parent = internalModules.path.dirname(dir);
			if (dir === root || parent === root || parent === dir) return null;
			dir = parent;
		}
	}

	let { pkgName, subpath } = splitBareSpecifier(target);
	let pjsonPath = findPackageJson(pkgName, basedir);
	if (!pjsonPath) return null;

	let pkg = JSON.parse(cachedReadFile(pjsonPath));
	if (!pkg || !pkg.exports) return null;

	let matched = exportsResolve(pkg, subpath, {
		conditions: ["node"],
		require: condition === "require",
	});
	if (!matched || matched.length === 0) {
		throw new Error(
			`Package "${pkgName}" has no "${subpath}" export under condition "${condition}"`
		);
	}
	let pkgDir = internalModules.path.dirname(pjsonPath);
	return internalModules.path.join(pkgDir, matched[0]);
}

// When the resolver lands on `<fromPkg>/<fromSubpath>`, serve
// `<toPkg>/<toSubpath>` instead. Used to swap native/prebuilt-binary modules
// for pure-WASM/JS equivalents, the way StackBlitz WebContainer does. We
// redirect to the target's real *path* (not a rewritten body) so its own
// relative requires resolve against the target install dir and find sibling
// assets (e.g. the `.wasm`).
interface ModuleRedirect {
	fromPkg: string;
	fromSubpath: string; // package-relative, no leading "./"
	toPkg: string;
	toSubpath: string;
	missingHint?: string; // thrown if toPkg isn't installed
}

let moduleRedirects: ModuleRedirect[] = [
	{
		// Rollup's dist/native.js only loads a prebuilt `.node` addon
		// (`@rollup/rollup-<platform>-<arch>`); for platform "browser"/arch
		// "wasm" there is none — its lookup table misses and it throws
		// `... not yet supported by the native Rollup build` before anything
		// loads. (And our npm-install ignores optionalDependencies, so the addon
		// packages aren't even on disk.) @rollup/wasm-node exposes the identical
		// `parse`/`parseAsync`/`xxhash*` API backed by a wasm SWC parser
		// (instantiated synchronously, which is allowed off the main thread), so
		// the AST buffer rollup's `convert-ast` decodes is byte-compatible.
		fromPkg: "rollup",
		fromSubpath: "dist/native.js",
		toPkg: "@rollup/wasm-node",
		toSubpath: "dist/native.js",
		missingHint:
			`rollup needs a native binding that doesn't exist for platform "browser"/arch "wasm". ` +
			`Add "@rollup/wasm-node" (matching your rollup major version) to your project's ` +
			`dependencies and reinstall so the runtime can use the WASM build.`,
	},
];

function maybeRedirectModule(path: string): string {
	for (let rule of moduleRedirects) {
		// Leading "/" anchors the match at a path segment boundary, so
		// "foo-rollup/dist/native.js" won't match the "rollup" rule.
		if (!path.endsWith(`/${rule.fromPkg}/${rule.fromSubpath}`)) continue;

		let toPkgJson = findPackageJson(rule.toPkg, internalModules.path.dirname(path));
		if (!toPkgJson) {
			throw new Error(
				rule.missingHint ??
					`"${rule.fromPkg}/${rule.fromSubpath}" redirects to "${rule.toPkg}", which isn't installed.`
			);
		}
		return internalModules.path.join(internalModules.path.dirname(toPkgJson), rule.toSubpath);
	}
	return path;
}

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

export function resolveSource(
	target: string,
	basedir: string,
	condition: ResolveCondition = "require"
): ResolvedSource {
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
		let cacheKey = condition + "\0" + basedir + "\0" + target;
		let cachedPath = resolvePathCache.get(cacheKey);
		if (cachedPath !== undefined) {
			path = cachedPath;
		} else {
			// Bare specifiers (and `#`-imports) may need exports/imports field
			// resolution, which `resolve` v1.x doesn't do. Try that first; on
			// miss (no exports field, or relative/absolute specifier) fall
			// through to the legacy main-field walk.
			let viaExports: string | null = null;
			let isBare =
				!target.startsWith(".") &&
				!target.startsWith("/") &&
				!internalModules.path.isAbsolute(target);
			if (isBare) {
				try {
					viaExports = resolveViaExportsField(target, basedir, condition);
				} catch (e) {
					console_warn("[node-worker] [resolve] exports resolution failed", e);
					throw e;
				}
			}
			if (viaExports !== null) {
				path = viaExports;
			} else {
				try {
					path = resolveSync(target, { ...resolveSyncOpts, basedir });
				} catch (e) {
					console_warn("[node-worker] [resolve] resolve failed", e);
					throw new Error(`Unknown target ${target}`, { cause: e });
				}
			}
			path = maybeRedirectModule(path);
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
