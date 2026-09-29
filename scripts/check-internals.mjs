import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
// These files carry internal messages or load user modules after user code runs.
const critical = [
	"src/vfs/path.ts",
	"src/wire/frame.ts",
	"src/wire/pack.ts",
	"src/wire/router.ts",
	"src/wire/endpoint.ts",
	"src/worker/module/compile.ts",
	"src/worker/module/cjs.ts",
	"src/worker/module/resolve.ts",
	"src/worker/epoxy/index.ts",
	"src/worker/epoxy/globals.ts",
	"src/worker/node/fs/transport.ts",
	"src/worker/node/fs/streams.ts",
	"src/worker/node/net/socket.ts",
	"src/worker/node/child_process.ts",
	"src/worker/node/worker_threads.ts",
	"src/worker/node/index.ts",
	"src/worker/peer.ts",
	"src/worker/puter.ts",
];
const mutableStatics = new Set([
	"Object",
	"Array",
	"JSON",
	"Reflect",
	"Promise",
	"Map",
	"Set",
	"ArrayBuffer",
	"Uint8Array",
]);
const mutableConstructors = new Set([
	"Request",
	"Response",
	"Headers",
	"URL",
	"TextEncoder",
	"TextDecoder",
	"MessageChannel",
	"ReadableStream",
	"WritableStream",
	"WebSocket",
]);
const sensitiveMethods = new Set([
	"postMessage",
	"getReader",
	"getWriter",
	"then",
	"catch",
]);
const failures = [];

for (const file of critical) {
	const source = ts.createSourceFile(
		file,
		fs.readFileSync(path.join(root, file), "utf8"),
		ts.ScriptTarget.Latest,
		true
	);
	function visit(node) {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression)
		) {
			const receiver = node.expression.expression;
			const method = node.expression.name.text;
			const directStatic =
				ts.isIdentifier(receiver) && mutableStatics.has(receiver.text);
			const directSensitive =
				sensitiveMethods.has(method) &&
				!(
					file === "src/wire/endpoint.ts" &&
					ts.isIdentifier(receiver) &&
					receiver.text === "target" &&
					method === "postMessage"
				);
			if (directStatic || directSensitive)
				report(
					node,
					`${directStatic ? receiver.text + "." : ""}${method} must use a saved method`
				);
		}
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			mutableConstructors.has(node.expression.text)
		)
			report(node, `new ${node.expression.text} must use a saved constructor`);
		ts.forEachChild(node, visit);
	}
	function report(node, message) {
		const line =
			source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
		failures.push(`${file}:${line}: ${message}`);
	}
	visit(source);
}
if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else console.log("critical internals use saved builtins");
