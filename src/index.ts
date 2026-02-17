import modules from "./node";
import { setPuterCWD, setPuterToken } from "./state";
import { require } from "./require";

export function runCode(
	code: string,
	async: boolean = false,
	extra: [string, string] = ["", ""],
	requireFn: (target: string) => any = require
): any {
	code = `${extra[0]}${code}${extra[1]}`;

	let harness;
	if (async) {
		harness = `return (async ({ fs, buffer, path, events, stream, util, zlib }, require) => {${code}})(modules, require)`;
	} else {
		harness = `return (({ fs, buffer, path, events, stream, util, zlib }, require) => {${code}})(modules, require)`;
	}

	let fn = new Function("modules", "require", harness);

	return fn(modules, requireFn);
}

export { modules, require, setPuterCWD, setPuterToken };
