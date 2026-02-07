import { defineConfig } from "rollup";
import fs from "node:fs/promises";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

let globOne = async (glob) => {
	for await (let ret of fs.glob(glob)) {
		return ret;
	}
}

let plugin = () => ({
	name: "monkeypatch-cjs",
	resolveId(source) {
		if (source === "create-require")
			return "\0create-require";
		if (source === "pkg-dir")
			return "\0pkg-dir";
		return null;
	},
	async load(source) {
		if (source === "\0create-require") {
			let code = await fs.readFile(await globOne("node_modules/.pnpm/create-require*/") + "/node_modules/create-require/create-require.js");

			return `
				${code};
				export default module.exports.createRequire;
			`
		}
		if (source === "\0pkg-dir") {
			let code = await fs.readFile(await globOne("node_modules/.pnpm/pkg-dir*/") + "/node_modules/pkg-dir/index.js");

			return `
				${code};
				export default module.exports;
			`
		}
	}
})

export default defineConfig({
	input: "src/index.ts",
	output: [{ file: "dist/index.js", format: "es" }],
	plugins: [nodeResolve(), typescript(), plugin()]
});
