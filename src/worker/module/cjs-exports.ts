import { parse } from "cjs-module-lexer";
import { resolveSource } from "./resolve";
import type { RuntimeResolvedSource } from "./resolve";

let cache: Map<string, string[]> = new Map();

let identifierRegex = /^[A-Za-z_$][\w$]*$/;
let reservedWords = new Set([
	"break", "case", "catch", "class", "const", "continue", "debugger",
	"default", "delete", "do", "else", "enum", "export", "extends", "false",
	"finally", "for", "function", "if", "import", "in", "instanceof", "new",
	"null", "return", "super", "switch", "this", "throw", "true", "try",
	"typeof", "var", "void", "while", "with", "yield", "let", "static",
	"implements", "interface", "package", "private", "protected", "public",
	"await", "__esModule",
]);

function isValidExportName(name: string): boolean {
	if (reservedWords.has(name)) return false;
	return identifierRegex.test(name);
}

export function detectCjsExports(source: RuntimeResolvedSource): string[] {
	if (cache.has(source.id)) return cache.get(source.id)!;

	// Seed the cache before recursing so cycles resolve to an empty interim
	// list. Matches upstream node's translators.js:397
	// (`module[kModuleExportNames] = exportNames` before reexport walk).
	let names = new Set<string>();
	cache.set(source.id, []);

	let parsed: { exports: string[]; reexports: string[] };
	try {
		parsed = parse(source.code);
	} catch {
		return [];
	}

	for (let name of parsed.exports) names.add(name);

	for (let reexport of parsed.reexports) {
		let resolved;
		try {
			resolved = resolveSource(reexport, source.dir, "require");
		} catch {
			continue;
		}
		if (resolved.type === "internal") {
			for (let name of Object.keys(resolved.exports)) names.add(name);
		} else if (resolved.type === "cjs") {
			for (let name of detectCjsExports(resolved)) names.add(name);
		}
		// esm reexports are skipped, matching upstream node's
		// translators.js:417 (only follows commonjs reexports).
	}

	let filtered = [...names].filter(isValidExportName).sort();
	cache.set(source.id, filtered);
	return filtered;
}
