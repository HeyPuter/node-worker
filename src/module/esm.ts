import { parse } from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";

export function rewriteEsm(_code: string): string {
	let code = new MagicString(_code);

	let parsed = parse(_code, { ecmaVersion: 2026 });

	walk.simple(parsed, {});

	return code.toString();
}
