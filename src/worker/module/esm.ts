import { parse } from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";
import { resolveSource, RuntimeResolvedSource } from "./resolve";
import { CWD } from "../state";
import { createCjsModule } from "./cjs";
import internalModules from "../node";

let internalModulesSymbol = "__puter_node_worker_internalModules";
let esmImportSymbol = "__puter_node_worker_esmImport";
let cjsHelperSymbol = "__puter_node_worker_cjsHelper";

interface RewrittenEsmSource {
	code: string;
	blob: Blob;
	bloburl: string;
}

let esmCache: Map<string, RewrittenEsmSource> = new Map();

function rewriteEsm(source: RuntimeResolvedSource): string {
	if (source.type !== "esm") throw "unreachable";

	let code = new MagicString(source.code);
	let parsed = parse(source.code, { ecmaVersion: 2026, sourceType: "module" });

	walk.simple(parsed, {
		ExportAllDeclaration(decl) {
			let resolved = resolveEsm(source.dir, decl.source.value as string);
			code.update(decl.source.start, decl.source.end, `"${resolved.bloburl}"`);
		},
		ExportNamedDeclaration(decl) {
			if (!decl.source) return;
			let resolved = resolveEsm(source.dir, decl.source.value as string);
			code.update(decl.source.start, decl.source.end, `"${resolved.bloburl}"`);
		},
		ImportDeclaration(decl) {
			let resolved = resolveEsm(source.dir, decl.source.value as string);
			code.update(decl.source.start, decl.source.end, `"${resolved.bloburl}"`);
		},
		ImportExpression(expr) {
			code.update(
				expr.start,
				expr.start + "import".length,
				`(globalThis[Symbol.for("${esmImportSymbol}")])`
			);
			code.appendLeft(expr.end - 1, `, "${source.dir}"`);
		},
	});

	return code.toString();
}

function resolveEsm(sourcedir: string, target: string): RewrittenEsmSource {
	let resolved = resolveSource(target, sourcedir);
	if (esmCache.has(resolved.id)) return esmCache.get(resolved.id)!;

	let code: string;
	let path: string;
	if (resolved.type === "internal") {
		let exports = "{ " + Object.keys(resolved.exports).join(", ") + " }";
		code = `
			// shim module to import internal "${resolved.module}"
			let ${exports} = globalThis[Symbol.for("${internalModulesSymbol}")]["${resolved.module}"]
			export ${exports};
		`;
		path = resolved.module;
	} else if (resolved.type === "esm") {
		code = rewriteEsm(resolved);
		path = resolved.path;
	} else {
		// TODO static analysis of cjs exports like what node does
		code = `
			// shim module to import cjs module "${resolved.id}"
			let exports = globalThis[Symbol.for("${cjsHelperSymbol}")](${JSON.stringify(resolved)});
			export default exports;
		`;
	}

	let blob = new Blob([code], { type: "text/javascript" });
	let src: RewrittenEsmSource = {
		code,
		blob,
		bloburl: URL.createObjectURL(blob),
	};
	esmCache.set(resolved.id, src);
	return src;
}

export async function esmImport(path: string, cwd = CWD): Promise<any> {
	let resolved = resolveEsm(cwd, path);
	return await import(resolved.bloburl);
}

function cjsHelper(source: RuntimeResolvedSource) {
	let [module, run] = createCjsModule(source);
	run();
	return module.exports;
}

(globalThis as any)[Symbol.for(internalModulesSymbol)] = internalModules;
(globalThis as any)[Symbol.for(esmImportSymbol)] = esmImport;
(globalThis as any)[Symbol.for(cjsHelperSymbol)] = cjsHelper;
