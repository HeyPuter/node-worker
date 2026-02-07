import { defineConfig } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import polyfills from "node-stdlib-browser";
import fs from "node:fs/promises";
import path from "node:path";
import terser from "@rollup/plugin-terser";

let NODE_EXTERNAL = "node-external:";
let plugin = () => ({
	name: "external-polyfills",
	resolveId(source) {
		if (source.startsWith(NODE_EXTERNAL)) {
			return "\0" + source;
		}
		return null;
	},
	async load(source) {
		if (source.startsWith("\0" + NODE_EXTERNAL)) {
			source = source.slice(NODE_EXTERNAL.length + 1);

			let pkgDir = polyfills[source];
			let pkg = JSON.parse(await fs.readFile(pkgDir + "/package.json", "utf-8"));
			let polyfill = await fs.readFile(path.resolve(pkgDir, pkg.main), "utf-8");

			return `
				${polyfill}
				export default module.exports;
			`;
		}
	}
})

export default defineConfig({
	input: "src/index.ts",
	output: [{ file: "dist/index.js", format: "es" }],
	plugins: [nodeResolve(), typescript(), terser(), plugin()],
});
