import { runCode } from ".";
import fs from "./fs";
import internalModules from "./node";

let PREAMBLE = `
let module = { exports: {} };


`;
let AFTERWORD = `


return module.exports;
`;

export function require(target: string): any {
	if (target.startsWith("node:")) {
		target = target.slice("node:".length);
		if (Object.hasOwn(internalModules, target)) {
			return (internalModules as any)[target];
		}
		throw new Error(`Unknown internal module "node:${target}"`);
	}

	// TODO replace with ncjsm?
	if (target.startsWith("./")) {
		try {
			let source = fs.readFileSync(target, "utf-8");

			return runCode(source, false, [PREAMBLE, AFTERWORD]);
		} catch(e) {
			throw new Error(`Failed to load module from "${target}"`, { cause: e })
		}
	}

	if (Object.hasOwn(internalModules, target)) {
		return (internalModules as any)[target];
	}

	throw new Error(`Unknown target ${target}`);
}
