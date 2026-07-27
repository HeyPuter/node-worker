import { console_warn } from "../console";
import { CWD } from "../state";
// Installs the Node-only globals (Buffer, process, timers, …) onto globalThis —
// CJS modules read them from there rather than via wrapper parameters (see
// CJS_HARNESS below) — and provides ACF_GLOBAL, the async-context holder name the
// await transform emits references to.
import { ACF_GLOBAL } from "./globals";
import { resolveSource } from "./resolve";
import type { RuntimeResolvedSource } from "./resolve";
import { getRewriter } from "../node-rust/loader";
import path from "../node/path";
import url from "../node/url";

let decoder = new TextDecoder();

// Wrap `await` expressions in the CJS source so the async context propagates
// across them (see the rewriter's rewrite_awaits / node/async_hooks). This is the
// await-only transform — no ESM lowering. Skipped when the source has no `await`
// token at all (the common case), and falls back to the original source on any
// parse/transform error so a module never fails to load because of this.
function transformCjsAwaits(id: string, code: string): string {
	if (!code.includes("await")) return code;
	try {
		let rewritten = getRewriter().transform_awaits(code, ACF_GLOBAL);
		for (let error of rewritten.errors) {
			console_warn("[node-worker] cjs await-rewrite error for", id, error);
		}
		return decoder.decode(rewritten.js);
	} catch (err) {
		console_warn("[node-worker] cjs await-rewrite failed for", id, err);
		return code;
	}
}

export interface CJSModule {
	children: CJSModule[];
	exports: any;
	filename: string;
	id: string;
	isPreloading: false;
	loaded: boolean;
	path: string;
	paths: string[];
	require: (id: string) => any;
}

// Match Node's real CJS module wrapper: only `require`, `module`, `exports`,
// `__dirname`, `__filename` are injected as parameters. Node globals (Buffer,
// process, timers, …) live on globalThis (installed by ./globals), NOT as
// wrapper params. Injecting them as params breaks any module that declares a
// top-level lexical binding of the same name — e.g. undici's
// `const Buffer = require('node:buffer').Buffer` throws
// "Identifier 'Buffer' has already been declared". As globals, such a
// declaration simply shadows the global within the module scope, as in Node.
let CJS_HARNESS = (code: string, module: CJSModule) =>
	new Function(
		"require",
		"module",
		"exports",
		"__dirname",
		"__filename",
		code
	).bind(
		null,
		module.require,
		module,
		module.exports,
		module.path,
		module.filename
	);

export function createCjsModule(
	resolvedSource: RuntimeResolvedSource
): [CJSModule, () => void] {
	let module: CJSModule = {
		children: [], // TODO handle children
		exports: Object.create(null),
		filename: resolvedSource.path,
		id: resolvedSource.path,
		isPreloading: false,
		loaded: false,
		path: resolvedSource.dir,
		paths: [], // TODO handle paths
		require: createRequireFromDir(resolvedSource.dir),
	};
	let harness = CJS_HARNESS(
		transformCjsAwaits(resolvedSource.path, resolvedSource.code),
		module
	);
	return [
		module,
		() => {
			harness();
			module.loaded = true;
		},
	];
}

let REQUIRE_CACHE: Record<string, any> = {};

function requireWithBasedir(target: string, basedir: string): any {
	let resolvedSource = resolveSource(target, basedir, "require");

	if (resolvedSource.type === "internal") {
		return resolvedSource.exports;
	}

	if (Object.hasOwn(REQUIRE_CACHE, resolvedSource.path)) {
		return REQUIRE_CACHE[resolvedSource.path];
	}

	try {
		if (resolvedSource.type === "esm") throw new Error("unsupported");
		let [module, fn] = createCjsModule(resolvedSource);

		REQUIRE_CACHE[resolvedSource.path] = module.exports;
		fn();
		REQUIRE_CACHE[resolvedSource.path] = module.exports;

		return module.exports;
	} catch (e) {
		console_warn("[node-worker] [resolve] [cjs] load failed", e);
		throw new Error(`Failed to load module from "${resolvedSource.path}"`, {
			cause: e,
		});
	}
}

interface RequireFn {
	(target: string): any;
	cache: Record<string, any>;
}

function createRequireFromDir(basedir: string): RequireFn {
	let fn: RequireFn = ((target: string) =>
		requireWithBasedir(target, basedir)) as any;
	fn.cache = REQUIRE_CACHE;
	return fn;
}

export function createRequire(filename: string | URL): RequireFn {
	let pathname =
		filename instanceof URL || String(filename).startsWith("file:")
			? url.fileURLToPath(filename as any)
			: String(filename);
	return createRequireFromDir(path.dirname(pathname));
}

export function require(target: string): any {
	return requireWithBasedir(target, CWD);
}
