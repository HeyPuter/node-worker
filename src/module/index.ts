import { createCjsModule } from "./cjs";

export function runCode(
	code: string,
	codePath: string,
	esm: boolean = false,
): any {
	if (esm) throw new Error("TODO");
	let [module, fn] = createCjsModule(code, codePath);

	fn();

	return module.exports;
}
