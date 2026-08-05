import { parse as cjsLexerParse } from "cjs-module-lexer";
import { sync as resolveSync } from "resolve";
import {
	exports as exportsResolve,
	imports as importsResolve,
} from "resolve.exports";

import internalModules from "../node";
import { console_debug, console_warn } from "../console";
import { ctx, host } from "../node/fs/host";
import { MAX_DEPTH, relDepth } from "../node/fs/readdir-encode";
import type { Listing } from "../../vfs/entry";

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
//
// Most of those stats are *misses* — `resolve` probing `x`, `x.js`,
// `x/index.js`, and `findPackageJson` asking every ancestor for a node_modules
// that isn't there — and a miss costs exactly as much as a hit. So rather than
// answering them one blocking round trip at a time, a probe into a node_modules
// pulls the whole tree down with one recursive `/fs/readdir` and answers from
// `completeDirs`: a directory whose child list is known in full turns every
// subsequent miss under it into a local ENOENT.
//
// This deliberately stays private to the resolver. Serving `fs.statSync`
// generally from a cache would go stale the moment another puter app writes to
// a path, and we have no way to hear about that; `statCache` was already
// never-invalidated for exactly these paths, so filling it from a listing
// instead of from N point stats is the same trust, not new trust.
type StatKind = "file" | "dir" | "missing";
let statCache: Map<string, StatKind> = new Map();
let readFileCache: Map<string, string> = new Map();
let packageTypeCache: Map<string, "module" | "commonjs" | undefined> =
	new Map();

// Directories whose children are all present in `statCache`, so a path under
// one of them that *isn't* in `statCache` is known not to exist.
let completeDirs: Set<string> = new Set();
// `<dir>/node_modules` roots already attempted, successfully or not. Recorded
// before the request so a missing node_modules costs one 404, not one per
// package name probed at that level.
let seededNodeModules: Set<string> = new Set();
// Package roots already walked at full depth. Once a package is hydrated a
// subsequent miss inside it is a real ENOENT and must not re-trigger.
let hydratedPackages: Set<string> = new Set();

// Deep enough to cover `<pkg>/<dir>/<file>` — so a package's `main`, its
// `exports` targets and `index.js` are all settled by the seed — and equally
// `@scope/<pkg>/package.json`, which is one level lower than the unscoped form.
//
// Measured against a 200-package install where a program loads 30 of them:
// depth 2 needs 32 blocking round trips (a seed plus one hydration per package
// reached into) and moves 2200 entries; depth 3 needs 2 and moves 4200. Twice
// the bytes for a sixteenth of the round trips is the right trade when every
// request is a synchronous XHR that freezes the worker.
const SEED_DEPTH = 3;
// Fallback for an install too big to seed at SEED_DEPTH. Just the package roots:
// enough to make `node_modules` itself complete, which is what kills
// findPackageJson's ancestor walk, at one page's worth of entries.
const SHALLOW_SEED_DEPTH = 1;
// Ceiling on one prefetch. Overrunning it degrades to positive-only caching
// (see `ingestListing`): slower, never wrong.
const PREFETCH_MAX_ENTRIES = 20000;

function ingestListing(root: string, depth: number, page: Listing) {
	for (let entry of page.entries) {
		statCache.set(entry.path, entry.isDir ? "dir" : "file");
	}
	// A truncated walk is a valid prefix of the listing but not an exhaustive
	// one, so it can't support any negative answers.
	if (!page.complete) return;

	// The listing is exhaustive for the root and for every directory whose own
	// children were inside the requested depth. A directory sitting *at* the
	// horizon came back — so we know it exists — but its children were never
	// asked for; marking it complete would invent ENOENTs for files that are
	// really there. Empty directories never appear as a parent above, which is
	// why this iterates the directory entries rather than what got cached.
	completeDirs.add(root);
	for (let entry of page.entries) {
		if (entry.isDir && relDepth(root, entry.path) < depth) {
			completeDirs.add(entry.path);
		}
	}
}

// Through the facade, NOT `readdirPagesPlan` directly.
//
// That plan is the *puterfs* listing — it builds a `/fs/readdir` request — so
// calling it here sent every prefetch to the network regardless of which backend
// actually owns the path. A dependency tree in an in-memory mount was therefore
// answered with a 404 and cached as missing, and the package became unresolvable
// even though `readdirSync` listed it perfectly well one line earlier.
//
// Everything else in this file already goes through `fs` (`cachedStatKind` and
// `cachedReadFile` both do); this was the one place that reached past it, and it
// predates there being anything to reach past.
function prefetch(root: string, depth: number): Listing {
	return host.readdir(ctx("scandir", root), root, {
		recursive: true,
		depth,
		maxEntries: PREFETCH_MAX_ENTRIES,
	});
}

function seedNodeModules(nmPath: string) {
	seededNodeModules.add(nmPath);
	let depth = SEED_DEPTH;
	let page: Listing;
	try {
		page = prefetch(nmPath, depth);
		if (!page.complete) {
			// Too big to enumerate at SEED_DEPTH. A shallow seed still settles
			// which packages exist; the ones actually loaded then come in whole,
			// one hydratePackage at a time.
			depth = SHALLOW_SEED_DEPTH;
			page = prefetch(nmPath, depth);
		}
	} catch (_e) {
		let e = _e as any;
		// No node_modules at this level — worth recording, since the ancestor
		// walk then answers every `<nmPath>/<pkg>/package.json` probe for free.
		if (e?.code === "ENOENT") statCache.set(nmPath, "missing");
		else if (e?.code !== "ENOTDIR")
			console_warn(
				"[node-worker] [resolve] node_modules prefetch failed",
				nmPath,
				e
			);
		return;
	}
	statCache.set(nmPath, "dir");
	ingestListing(nmPath, depth, page);
}

function hydratePackage(pkgRoot: string) {
	hydratedPackages.add(pkgRoot);
	try {
		ingestListing(pkgRoot, MAX_DEPTH, prefetch(pkgRoot, MAX_DEPTH));
	} catch (e) {
		console_warn("[node-worker] [resolve] package prefetch failed", pkgRoot, e);
	}
}

// Locate the deepest `node_modules` on `path` and, within it, the package root
// (`<nm>/<pkg>` or `<nm>/@scope/<pkg>`). Returns null when `path` isn't inside a
// node_modules at all — the resolver only prefetches dependency trees, never the
// user's own source, which is the tree that actually changes underfoot.
function splitNodeModulesPath(
	path: string
): { nm: string; pkg: string | null } | null {
	if (path.endsWith("/node_modules")) return { nm: path, pkg: null };

	let idx = path.lastIndexOf("/node_modules/");
	if (idx === -1) return null;

	let nm = path.slice(0, idx + "/node_modules".length);
	let parts = path.slice(idx + "/node_modules/".length).split("/");
	// Scoped packages are two segments; a bare `@scope` directory is not a
	// package and has no root of its own.
	let take = parts[0].startsWith("@") ? 2 : 1;
	if (parts.length < take) return { nm, pkg: null };
	return { nm, pkg: `${nm}/${parts.slice(0, take).join("/")}` };
}

// What we can conclude about `path` from the ancestors we've already listed,
// without touching the network: nothing exists under a fully-listed directory
// that didn't appear in it, and nothing exists under a missing directory or
// under a file.
function inferKind(path: string): StatKind | undefined {
	let known = statCache.get(path);
	if (known !== undefined) return known;

	let parent = internalModules.path.dirname(path);
	if (parent === path) return undefined;
	if (completeDirs.has(parent)) return "missing";

	let parentKind = inferKind(parent);
	if (parentKind === "missing" || parentKind === "file") return "missing";
	return undefined;
}

function lookupCached(path: string): StatKind | undefined {
	let kind = inferKind(path);
	if (kind !== undefined) statCache.set(path, kind);
	return kind;
}

function cachedStatKind(path: string): StatKind {
	let hit = lookupCached(path);
	if (hit !== undefined) return hit;

	// Unknown, and inside a dependency tree: one recursive listing answers this
	// probe and every other one under the same tree. Tier 1 lays out the
	// packages; tier 2 fills in the one package we're actually reaching into.
	let nm = splitNodeModulesPath(path);
	if (nm) {
		if (!seededNodeModules.has(nm.nm)) {
			seedNodeModules(nm.nm);
			hit = lookupCached(path);
			if (hit !== undefined) return hit;
		}
		if (
			nm.pkg &&
			!hydratedPackages.has(nm.pkg) &&
			statCache.get(nm.pkg) === "dir"
		) {
			hydratePackage(nm.pkg);
			hit = lookupCached(path);
			if (hit !== undefined) return hit;
		}
	}

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
	// Detect esm via cjs-module-lexer, not a full acorn parse: real-world
	// dependency files (e.g. highlight.js's generated language grammars) nest
	// expressions deep enough — hundreds of `+` / call levels — that acorn's
	// recursive-descent parser blows the worker's call stack. The lexer is an
	// O(n) char scanner that can't overflow, and it throws with code
	// "ERR_LEXER_ESM_SYNTAX" the instant it hits a top-level import/export
	// statement. Anything it lexes cleanly is treated as commonjs (node's
	// default for an ambiguous `.js`). Files whose only esm marker is
	// `import.meta` or bare top-level await — with no import/export statement —
	// fall through to cjs, but those are vanishingly rare and never arise here.
	try {
		cjsLexerParse(code);
		return false;
	} catch (e) {
		return (e as any)?.code === "ERR_LEXER_ESM_SYNTAX";
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
	// Decided by extension like the two above, and deliberately ahead of the package
	// type: node's `.json` handler lives in the CJS loader (see `createCjsModule`), so a
	// `"type": "module"` package.json overhead does not make a data file a module.
	if (ext === ".json") return "cjs";

	let packageType = readPackageType(source.path);
	if (packageType === "module") return "esm";
	if (packageType === "commonjs") return "cjs";

	return hasEsmOnlySyntax(source.code) ? "esm" : "cjs";
}

// `(condition, basedir, target)` → resolved path. Skips the entire node_modules
// walk on repeat lookups (very common: every file in a package re-requires its
// peers). Condition is part of the key because exports/imports can map the
// same specifier to different files under `import` vs `require`.
let resolvePathCache: Map<string, string> = new Map();

// Split a bare specifier into its package name and the requested subpath.
// "ws" → { pkgName: "ws", subpath: "." }
// "ws/lib/foo" → { pkgName: "ws", subpath: "./lib/foo" }
// "@scope/pkg/sub" → { pkgName: "@scope/pkg", subpath: "./sub" }
function splitBareSpecifier(target: string): {
	pkgName: string;
	subpath: string;
} {
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
	{
		// esbuild's JS API is a *client*: `lib/main.js` looks up
		// `@esbuild/<platform>-<arch>` for a prebuilt executable and talks to it
		// over a pipe via child_process. Platform "browser"/arch "wasm" isn't in
		// its table ("Unsupported platform: browser wasm LE"), no such package
		// exists, and child_process can't spawn anything here regardless.
		//
		// Unlike @rollup/wasm-node, esbuild-wasm is not a drop-in: its own
		// `lib/main.js` is that same subprocess client, and the usable half
		// (`lib/browser.js`) has a different contract — an explicit
		// `initialize()` with the wasm bytes, async-only APIs, and a Go runtime
		// that needs `globalThis.fs` wired up before it can see any files. So the
		// target here is an adapter that the harness installs into esbuild-wasm's
		// own lib/ (node-worker-test/src/shims/esbuild-wasm.cjs, written by its
		// npm-install). Keeping it there rather than in this bundle means the
		// runtime's whole share of the swap is this rule, and the shim's
		// `require("./browser.js")` and `__dirname`-relative wasm read resolve on
		// their own.
		fromPkg: "esbuild",
		fromSubpath: "lib/main.js",
		toPkg: "esbuild-wasm",
		toSubpath: "lib/node-worker-shim.cjs",
		missingHint:
			`esbuild drives a native binary subprocess, which doesn't exist for platform ` +
			`"browser"/arch "wasm". Add "esbuild-wasm" (same version as your esbuild) to ` +
			`your project's dependencies and reinstall with node-worker frontend so the runtime can use the WASM build.`,
	},
];

function maybeRedirectModule(path: string): string {
	for (let rule of moduleRedirects) {
		// Leading "/" anchors the match at a path segment boundary, so
		// "foo-rollup/dist/native.js" won't match the "rollup" rule.
		if (!path.endsWith(`/${rule.fromPkg}/${rule.fromSubpath}`)) continue;

		let toPkgJson = findPackageJson(
			rule.toPkg,
			internalModules.path.dirname(path)
		);
		if (!toPkgJson) {
			throw new Error(
				rule.missingHint ??
					`"${rule.fromPkg}/${rule.fromSubpath}" redirects to "${rule.toPkg}", which isn't installed.`
			);
		}
		return internalModules.path.join(
			internalModules.path.dirname(toPkgJson),
			rule.toSubpath
		);
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

/**
 * One authoritative retry for a *path* specifier the caches called missing.
 *
 * These caches never expire, which the header explains is safe for a dependency tree.
 * It is not safe for a file the running program creates: a directory that was listed in
 * full before the file existed answers "nothing there" forever, and `lookupCached` then
 * writes that inference down as a fact. Vite hits this on every start with a config
 * file — it bundles `vite.config.ts` into `node_modules/.vite-temp/…mjs` and imports it,
 * inside a tree whose listing was completed while resolving vite itself.
 *
 * A stale *negative* is the only staleness possible here (a positive cannot appear from
 * nowhere), so it is enough to stat the one path being asked about. Bare specifiers are
 * excluded by the caller: their misses are the volume these negatives exist to make
 * free, and an optional-dependency probe must stay a local no-op.
 *
 * The ancestors' `completeDirs` markers are deliberately left in place. They remain
 * exhaustive for everything that existed when they were taken, and dropping one to learn
 * about a single new file would put a whole dependency tree back on the network.
 */
function retryMissedPath(target: string, basedir: string): string | undefined {
	let candidate = internalModules.path.resolve(basedir, target);
	let kind: StatKind;
	try {
		kind = internalModules.fs.statSync(candidate).isDirectory()
			? "dir"
			: "file";
	} catch {
		// Genuinely absent: the negative was right.
		return undefined;
	}

	// An explicit entry beats anything `inferKind` would derive, so recording what is
	// really there is all it takes — for the file and for the directories that had to be
	// invented along with it.
	statCache.set(candidate, kind);
	for (let dir = internalModules.path.dirname(candidate); ; ) {
		if (statCache.get(dir) === "missing") statCache.set(dir, "dir");
		let parent = internalModules.path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	try {
		return resolveSync(target, { ...resolveSyncOpts, basedir });
	} catch {
		return undefined;
	}
}

// node 11 code or something
function stripShebang(content: string): string {
	if (content.charAt(0) === "#" && content.charAt(1) === "!") {
		let index = content.indexOf("\n", 2);
		if (index === -1) return "";
		if (content.charAt(index - 1) === "\r") index--;
		content = content.slice(index);
	}
	return content;
}

// A failed resolve is not automatically a problem: probing for an optional
// dependency and falling back is a normal pattern in real packages — `debug`
// does `try { humanize = require("ms") } catch { humanize = ownImpl }`, `ws`
// does it for `bufferutil`/`utf-8-validate`, `chokidar` for `fsevents` — so
// warning here shouted about four working fallbacks on every vite run. The
// throw is the whole report; whoever ends up handling it decides whether it
// mattered. `console_debug` keeps a trace at devtools' Verbose level for when
// a resolve fails and you want to know why.
//
// The error must also carry node's `code`, because the other half of that
// pattern is `catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e }` — the
// old `new Error("Unknown target x")` wrapper dropped the `code` that
// `resolve` sets, turning an expected miss into a rethrown crash.
function moduleNotFound(
	target: string,
	basedir: string,
	condition: ResolveCondition,
	cause: unknown
): Error {
	console_debug("[node-worker] [resolve] resolve failed", cause);
	let err = new Error(`Cannot find module '${target}' from '${basedir}'`, {
		cause,
	}) as Error & { code: string };
	// `require` and `import` fail under different codes upstream.
	err.code =
		condition === "require" ? "MODULE_NOT_FOUND" : "ERR_MODULE_NOT_FOUND";
	return err;
}

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

	// `import()` takes a file: URL as readily as a path, and for a path computed at runtime
	// the URL is the *idiomatic* form — `await import(pathToFileURL(p).href)` is how you load
	// one without a bare specifier being assumed. It is how vite loads every `vite.config.ts`:
	// the config is bundled to a temp `.mjs` and imported by URL, so without this no project
	// with a config file can start.
	//
	// Converted here, at the edge, because module ids on this side are paths — only
	// `import.meta.url` is a URL (see `System.createContext`). `require` is deliberately left
	// out: node's CJS loader takes no URLs either.
	if (condition === "import" && target.startsWith("file:")) {
		target = internalModules.url.fileURLToPath(target);
	}

	// No special case for injected sources any more. They are real files in the
	// in-memory overlay mounted over "/" (see node/fs/vfs/virtual.ts), so they
	// resolve, stat and read through exactly this path — which is also what makes a
	// relative `require("./x")` inside one resolve against its own directory rather
	// than against the root, and lets `detectRuntimeSourceType` find the enclosing
	// package.json the ordinary way.
	let path: string;
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
				// A path that was written after its directory was listed reads as missing
				// from cache alone; ask the filesystem before believing it.
				let retried = isBare ? undefined : retryMissedPath(target, basedir);
				if (retried === undefined) {
					throw moduleNotFound(target, basedir, condition, e);
				}
				path = retried;
			}
		}
		path = maybeRedirectModule(path);
		resolvePathCache.set(cacheKey, path);
	}
	let code = stripShebang(cachedReadFile(path));

	return {
		type: detectRuntimeSourceType({ path, code }),
		id: path,
		dir: internalModules.path.dirname(path),
		path,
		code,
	};
}

/**
 * Forget everything this module has cached about `path`.
 *
 * The caches here are deliberately permanent — the comment at the top explains why
 * that was safe when the only thing they described was installed dependencies. A
 * file that can be *replaced* at runtime breaks that assumption, and the overlay
 * (node/fs/vfs/virtual.ts) is exactly such a case: the testbed re-registers its eval
 * module at one stable path on every run. Without this, the second run would compile
 * the first run's source.
 *
 * The parent's `completeDirs` entry goes too: a path that was previously *absent*
 * from a fully-listed directory is cached as a negative, and the file appearing
 * makes that negative wrong.
 *
 * This is a stopgap. When the general fs cache lands these caches are deleted in
 * favour of it, and invalidation stops being something callers have to remember.
 */
export function invalidateResolved(path: string) {
	statCache.delete(path);
	readFileCache.delete(path);
	completeDirs.delete(internalModules.path.dirname(path));
}

/**
 * Forget everything cached at or below `prefix`.
 *
 * Mounting a filesystem somewhere invalidates far more than one path: every probe
 * that concluded "nothing here" while the mount was absent is now wrong, including
 * the negatives `inferKind` derives from a fully-listed ancestor, and the
 * already-seeded/hydrated markers that stop a dependency tree being re-scanned.
 *
 * A linear sweep, because these maps are keyed by path with no index. That is fine
 * for something that happens at mount time and not per operation.
 */
export function invalidateResolvedSubtree(prefix: string) {
	let under = (p: string) =>
		p === prefix || p.startsWith(prefix === "/" ? "/" : prefix + "/");

	for (let key of [...statCache.keys()]) if (under(key)) statCache.delete(key);
	for (let key of [...readFileCache.keys()])
		if (under(key)) readFileCache.delete(key);
	for (let key of [...packageTypeCache.keys()])
		if (under(key)) packageTypeCache.delete(key);
	for (let key of [...completeDirs]) if (under(key)) completeDirs.delete(key);
	for (let key of [...seededNodeModules])
		if (under(key)) seededNodeModules.delete(key);
	for (let key of [...hydratedPackages])
		if (under(key)) hydratedPackages.delete(key);

	// Ancestors matter too: a directory listed as complete *above* the mount point
	// was listed without it, so it would answer "no such path" for the mount itself.
	let dir = prefix;
	while (true) {
		let parent = internalModules.path.dirname(dir);
		completeDirs.delete(parent);
		statCache.delete(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// `resolvePathCache` maps a specifier to a resolved path. An entry that resolved
	// somewhere else stays valid, but one that resolved *into* this subtree may now
	// point at a shadowed file.
	for (let [key, value] of [...resolvePathCache]) {
		if (under(value)) resolvePathCache.delete(key);
	}
}
