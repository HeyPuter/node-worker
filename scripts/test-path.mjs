import assert from "node:assert/strict";
import path from "node:path";
import { rollup } from "rollup";
import typescript from "@rollup/plugin-typescript";

const root = path.resolve(import.meta.dirname, "..");
const bundle = await rollup({
	input: path.join(root, "src/vfs/path.ts"),
	plugins: [
		typescript({
			tsconfig: path.join(root, "tsconfig.worker.json"),
			declaration: false,
		}),
	],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();
const paths = await import(
	`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
);

const targets = [
	[String.prototype, "startsWith"],
	[String.prototype, "endsWith"],
	[String.prototype, "split"],
	[String.prototype, "slice"],
	[String.prototype, "charCodeAt"],
	[String.prototype, "lastIndexOf"],
	[Array.prototype, "push"],
	[Array.prototype, "pop"],
	[Array.prototype, "filter"],
	[Array.prototype, "join"],
	[JSON, "stringify"],
];
const originals = targets.map(([object, name]) => [object, name, object[name]]);
const intercepted = () => {
	throw new Error("path operation intercepted");
};
let result;
try {
	for (const [object, name] of targets) object[name] = intercepted;
	result = {
		normalized: paths.normalize("/tmp/../../etc/../safe/"),
		inside: paths.under("/safe", "/safe/file"),
		outside: paths.under("/safe", "/safe-evil/file"),
		local: paths.toLocal("/safe", "/safe/file"),
		relative: paths.relative("/safe/a", "/safe/b/file"),
		invalid: (() => {
			try {
				paths.checkRoot("/safe/../escape");
				return false;
			} catch {
				return true;
			}
		})(),
	};
} finally {
	for (const [object, name, original] of originals) object[name] = original;
}
assert.deepEqual(result, {
	normalized: "/safe/",
	inside: true,
	outside: false,
	local: "/file",
	relative: "../b/file",
	invalid: true,
});
console.log(
	"mount containment survives string and array prototype replacement"
);
