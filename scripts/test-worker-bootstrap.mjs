import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist/worker.js"), "utf8");
const binding = source.match(/const nodePrimordials = ([\w$]+);/)?.[1];
assert.ok(
	binding,
	"worker bundle must retain the upstream primordials binding"
);

const directory = fs.mkdtempSync(
	path.join(os.tmpdir(), "nodeworker-bootstrap-")
);
const file = path.join(directory, "worker.mjs");
fs.writeFileSync(file, `${source}\nexport { ${binding} as __primordials };\n`);
const nativeConsole = console;
globalThis.self = globalThis;
try {
	const { __primordials: p } = await import(pathToFileURL(file).href);
	for (const name of [
		"ObjectHasOwn",
		"ArrayPrototypeSort",
		"MapPrototypeForEach",
		"JSONStringify",
	])
		assert.equal(typeof p[name], "function", name);
	const original = Object.hasOwn;
	try {
		Object.hasOwn = () => {
			throw new Error("intercepted");
		};
		assert.equal(p.ObjectHasOwn({ ok: true }, "ok"), true);
	} finally {
		Object.hasOwn = original;
	}
	nativeConsole.log(
		"worker bootstrap initializes upstream primordials before runtime modules"
	);
} finally {
	fs.rmSync(directory, { recursive: true, force: true });
}
