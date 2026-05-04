import { CWD } from "../state";
import { NODE_GLOBALS } from "./globals";
import { resolveSource } from "./resolve";
import type { RuntimeResolvedSource } from "./resolve";

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

// Names destructured from NODE_GLOBALS into the CJS function scope. Keep
// this list in sync with NODE_GLOBALS keys — listing them explicitly makes
// the injected names visible to anyone reading the harness.
let GLOBAL_NAMES = Object.keys(NODE_GLOBALS).join(", ");

let CJS_HARNESS = (code: string, module: CJSModule) =>
	new Function(
		"globals",
		"module",
		`
		(({ ${GLOBAL_NAMES} }, require, module, exports, __dirname, __filename) => {
			${code}
		})(globals, module.require, module, module.exports, module.path, module.filename)
	`
	).bind(null, NODE_GLOBALS, module);

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
		require: createRequire(resolvedSource.dir),
	};
	let harness = CJS_HARNESS(resolvedSource.code, module);
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
	let resolvedSource = resolveSource(target, basedir);

	if (resolvedSource.type === "internal") {
		return resolvedSource.exports;
	}

	if (Object.hasOwn(REQUIRE_CACHE, resolvedSource.path)) {
		return REQUIRE_CACHE[resolvedSource.path];
	}

	try {
		if (resolvedSource.type === "esm") throw new Error("unsupported");
		let [module, fn] = createCjsModule(resolvedSource);

		fn();

		REQUIRE_CACHE[resolvedSource.path] = module.exports;
		return module.exports;
	} catch (e) {
		throw new Error(`Failed to load module from "${resolvedSource.path}"`, {
			cause: e,
		});
	}
}

interface RequireFn {
	(target: string): any;
	cache: Record<string, any>;
}

export function createRequire(basedir: string): RequireFn {
	let fn: RequireFn = ((target: string) =>
		requireWithBasedir(target, basedir)) as any;
	fn.cache = REQUIRE_CACHE;
	return fn;
}

export function require(target: string): any {
	return requireWithBasedir(target, CWD);
}
