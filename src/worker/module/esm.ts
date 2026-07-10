import { init as initEsmLexer, parse as parseEsm } from "es-module-lexer";
import MagicString from "magic-string";
import { resolveSource, RuntimeResolvedSource } from "./resolve";
import { CWD } from "../state";
import { createCjsModule } from "./cjs";
import { detectCjsExports } from "./cjs-exports";
import internalModules from "../node";
import "./globals";

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
	// es-module-lexer is an O(n), non-recursive wasm lexer — unlike acorn's
	// recursive-descent parser, it can't blow the worker's call stack on
	// deeply-nested expressions (which real-world dependency bundles routinely
	// contain). It reports every import/export specifier, dynamic import(), and
	// import.meta with byte offsets, which is all the rewriting below needs.
	let [imports] = parseEsm(source.code);

	let importMeta = `({ dirname: ${JSON.stringify(source.dir)}, filename: ${JSON.stringify(source.path)}, url: ${JSON.stringify(internalModules.url.pathToFileURL(source.path))} })`;

	for (let imp of imports) {
		if (imp.d === -2) {
			// `import.meta`: imp.ss..imp.se spans the whole `import.meta`.
			code.update(imp.ss, imp.se, importMeta);
		} else if (imp.d >= 0) {
			// dynamic `import(...)`: route through the runtime esm import helper,
			// threading the importing module's dir so relative specifiers resolve.
			// imp.ss is the `import` keyword; imp.se is just past the closing `)`.
			code.update(
				imp.ss,
				imp.ss + "import".length,
				`(globalThis[Symbol.for("${esmImportSymbol}")])`
			);
			code.appendLeft(imp.se - 1, `, ${JSON.stringify(source.dir)}`);
		} else {
			// static import / `export ... from`: imp.n is the specifier and
			// imp.s..imp.e spans it *without* the surrounding quotes, so updating
			// that range to the blob url keeps the quotes intact.
			if (imp.n === undefined) continue;
			let resolved = resolveEsm(source.dir, imp.n);
			code.update(imp.s, imp.e, resolved.bloburl);
		}
	}

	return code.toString();
}

function resolveEsm(sourcedir: string, target: string): RewrittenEsmSource {
	let resolved = resolveSource(target, sourcedir, "import");
	if (esmCache.has(resolved.id)) return esmCache.get(resolved.id)!;

	let code: string;
	let path: string;
	if (resolved.type === "internal") {
		let exports = "{ " + Object.keys(resolved.exports).join(", ") + " }";
		code = `
			// shim module to import internal "${resolved.module}"
			let ${exports} = globalThis[Symbol.for("${internalModulesSymbol}")]["${resolved.module}"]
			export ${exports};
			export default ${exports};
		`;
		path = resolved.module;
	} else if (resolved.type === "esm") {
		code = rewriteEsm(resolved);
		path = resolved.path;
	} else {
		let names = detectCjsExports(resolved);
		let named = names.length
			? `let { ${names.join(", ")} } = exports;\nexport { ${names.join(", ")} };`
			: "";
		code = `
			// shim module to import cjs module "${resolved.id}"
			let exports = globalThis[Symbol.for("${cjsHelperSymbol}")](${JSON.stringify(resolved)});
			${named}
			export default exports;
		`;
		path = resolved.path;
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
	// es-module-lexer's wasm must be instantiated before parseEsm() is called
	// synchronously inside the recursive rewriteEsm() below. `initEsmLexer` is a
	// promise that resolves once; awaiting it again after that is a no-op.
	await initEsmLexer;
	let resolved = resolveEsm(cwd, path);
	return await import(/* @vite-ignore */ resolved.bloburl);
}

function cjsHelper(source: RuntimeResolvedSource) {
	let [module, run] = createCjsModule(source);
	run();
	return module.exports;
}

(globalThis as any)[Symbol.for(internalModulesSymbol)] = internalModules;
(globalThis as any)[Symbol.for(esmImportSymbol)] = esmImport;
(globalThis as any)[Symbol.for(cjsHelperSymbol)] = cjsHelper;
