import {
	resolveSource,
	ResolvedSource,
	RuntimeResolvedSource,
} from "./resolve";
import { CWD } from "../state";
import { createCjsModule } from "./cjs";
import internalModules from "../node";
import "./globals";
import System, { Registration } from "isolated-systemjs";
import { getRewriter } from "../node-rust/loader";
import { console_warn } from "../console";

let PUTER_NODE_SYSTEMJS = "__puter_node_systemjs";
let decoder = new TextDecoder();
let pending = new Map<string, ResolvedSource>();

function exportNamespace(_export, ns) {
	_export("default", ns);
	if (ns != null && (typeof ns === "object" || typeof ns === "function"))
		for (const k of Object.keys(ns)) if (k !== "default") _export(k, ns[k]);
}

function esmHelper(src: RuntimeResolvedSource) {
	if (src.type !== "esm") throw "";

	let rewritten = getRewriter().rewrite_js(src.code, PUTER_NODE_SYSTEMJS);
	for (let error of rewritten.errors) {
		console_warn("[node-worker] rewrite error for", src.id, error);
	}

	let js = decoder.decode(rewritten.js);
	try {
		return new Function(PUTER_NODE_SYSTEMJS, js);
	} catch (err) {
		console_warn("[node-worker] failed to create function for", src.id, js);
		throw err;
	}
}

System.resolve = function (id, parent) {
	let src = resolveSource(
		id,
		parent ? internalModules.path.dirname(parent) : CWD,
		"import"
	);
	pending.set(src.id, src);
	return src.id;
};
// SystemJS's default createContext yields `{ url: id }` only, and our module ids
// are bare filesystem paths — so `import.meta.url` would be a path, not a
// file:// URL, and `import.meta.{filename,dirname}` (Node 20.11+, used by vite &
// friends) would be missing. Rebuild the context to match node's import.meta.
// Only ESM registrations receive a context (their declare has arity 2); the
// internal/cjs registrations below use an arity-1 declare, so `id` here is
// always an ESM module's resolved absolute path.
let baseCreateContext = System.createContext.bind(System);
System.createContext = function (id) {
	let ctx = baseCreateContext(id) as any;
	ctx.url = internalModules.url.pathToFileURL(id).href;
	ctx.filename = id;
	ctx.dirname = internalModules.path.dirname(id);
	return ctx;
};
System.instantiate = async function (url) {
	let src = pending.get(url);
	pending.delete(url);
	if (!src) throw new Error("unknown module instantiated" + url);

	if (src.type === "internal") {
		return [
			[],
			(_export) => ({
				execute() {
					exportNamespace(_export, src.exports);
				},
			}),
		] satisfies Registration;
	} else if (src.type === "cjs") {
		let [module, run] = createCjsModule(src);
		return [
			[],
			(_export) => ({
				execute() {
					run();
					exportNamespace(_export, module.exports);
				},
			}),
		] satisfies Registration;
	} else if (src.type === "esm") {
		esmHelper(src)(System);
		return System.getRegister() as Registration;
	} else {
		throw new Error("unreachable");
	}
};

export function esmImport(src: string) {
	return System.import(src);
}
