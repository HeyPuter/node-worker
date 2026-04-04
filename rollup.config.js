import { defineConfig } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import inject from "@rollup/plugin-inject";
import polyfills from "node-stdlib-browser";
import json from "@rollup/plugin-json";
import terser from "@rollup/plugin-terser";
import dts from "rollup-plugin-dts";

let NODE_EXTERNAL = "node-external:";

let plugin = () => ({
	name: "external-polyfills",
	resolveId(source, importer) {
		if (source.startsWith(NODE_EXTERNAL)) {
			let moduleName = source.slice(NODE_EXTERNAL.length);
			let pkgPath = polyfills[moduleName];
			if (pkgPath) {
				// Return the path and let it be further resolved
				return this.resolve(pkgPath, undefined, { skipSelf: true });
			}
		}
		// Handle bare node module imports and redirect to polyfills
		if (importer && polyfills[source]) {
			return this.resolve(polyfills[source], undefined, { skipSelf: true });
		}
		return null;
	},
});

export default defineConfig([
	{
		input: "src/worker/index.ts",
		output: [{ file: "dist/worker.js", format: "es" }],
		onwarn(warning, warn) {
			// Suppress circular dependency warnings
			if (warning.code === "CIRCULAR_DEPENDENCY") return;
			warn(warning);
		},
		plugins: [
			plugin(),
			nodeResolve({
				preferBuiltins: false,
				mainFields: ["browser", "module", "main"],
			}),
			commonjs(),
			json(),
			inject({
				process: polyfills.process,
			}),
			typescript({
				tsconfig: "./tsconfig.worker.json",
			}),
			//			terser()
		],
	},
	{
		input: "src/index.ts",
		output: [{ file: "dist/index.js", format: "es" }],
		onwarn(warning, warn) {
			// Suppress circular dependency warnings
			if (warning.code === "CIRCULAR_DEPENDENCY") return;
			warn(warning);
		},
		plugins: [
			typescript({
				tsconfig: "./tsconfig.main.json",
			}),
			//			terser()
		],
	},
	{
		input: "src/index.ts",
		output: [{ file: "dist/index.d.ts", format: "es" }],
		plugins: [dts()],
	},
	{
		input: "src/worker/index.ts",
		output: [{ file: "dist/worker.d.ts", format: "es" }],
		plugins: [dts()],
	},
]);
