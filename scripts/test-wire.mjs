import assert from "node:assert/strict";
import path from "node:path";
import { rollup } from "rollup";
import typescript from "@rollup/plugin-typescript";

const root = path.resolve(import.meta.dirname, "..");
const entry = "\0wire-test-entry";
const bundle = await rollup({
	input: "wire-test-entry",
	plugins: [
		{
			name: "wire-test-entry",
			resolveId(id) {
				return id === "wire-test-entry" ? entry : null;
			},
			load(id) {
				if (id !== entry) return null;
				return `export { PortEndpoint } from ${JSON.stringify(path.join(root, "src/wire/endpoint.ts"))};
export { makeDispatcher } from ${JSON.stringify(path.join(root, "src/wire/router.ts"))};`;
			},
		},
		typescript({
			tsconfig: path.join(root, "tsconfig.worker.json"),
			declaration: false,
		}),
	],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();
const { PortEndpoint, makeDispatcher } = await import(
	`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
);

const left = new PortEndpoint();
const right = new PortEndpoint();
const channel = new MessageChannel();
left.attach(channel.port1);
right.attach(channel.port2);
right.router.register(
	7,
	makeDispatcher(7, async (request) => ({
		value: { echoed: request.value },
	}))
);
// Node loads its own MessageEvent implementation on the first port message.
// Warm that platform path before mutating prototypes; the test targets our wire.
await left.call(7, { op: "warmup", value: 0 });

const targets = [
	[JSON, "stringify"],
	[JSON, "parse"],
	[Map.prototype, "get"],
	[Map.prototype, "set"],
	[Map.prototype, "has"],
	[Map.prototype, "delete"],
	[Map.prototype, "clear"],
	[Map.prototype, "forEach"],
	[MessagePort.prototype, "postMessage"],
	[MessagePort.prototype, "start"],
	[DataView.prototype, "getUint16"],
	[DataView.prototype, "getUint32"],
	[DataView.prototype, "setUint16"],
	[DataView.prototype, "setUint32"],
	[TextEncoder.prototype, "encode"],
	[TextDecoder.prototype, "decode"],
	[Uint8Array.prototype, "set"],
	[Uint8Array.prototype, "subarray"],
	[Array.prototype, "push"],
	[Array.prototype, "map"],
	[Array.prototype, "slice"],
	[Promise.prototype, "then"],
	[Promise.prototype, "catch"],
];
const originals = targets.map(([object, name]) => [object, name, object[name]]);
const intercepted = () => {
	throw new Error("internal call intercepted");
};
let result;
const deadline = setTimeout(
	() => left.close(new Error("wire timed out")),
	2000
);
try {
	for (const [object, name] of targets) object[name] = intercepted;
	result = await left.call(7, { op: "probe", value: 42 });
} finally {
	clearTimeout(deadline);
	for (const [object, name, original] of originals) object[name] = original;
	left.close();
	right.close();
}
assert.deepEqual(result.decoded.header.result, {
	ok: true,
	value: { echoed: 42 },
});
const chunkSizes = [131_072, 262_144, 524_288];
const stream = new ReadableStream({
	start(controller) {
		for (const size of chunkSizes) controller.enqueue(new Uint8Array(size));
		controller.close();
	},
});
// Reattach for the stream test after the poisoned-prototype test closed both ends.
const streamChannel = new MessageChannel();
const streamSender = new PortEndpoint();
const streamReceiver = new PortEndpoint();
streamSender.attach(streamChannel.port1);
streamReceiver.attach(streamChannel.port2);
streamReceiver.router.register(
	8,
	makeDispatcher(8, async (_request, _parts, attachments) => ({
		transfer: [attachments[0]],
	}))
);
const transferred = await streamSender.call(
	8,
	{ op: "stream" },
	{ transfer: [stream] }
);
const reader = transferred.attachments[0].getReader();
let bytes = 0;
for (;;) {
	const next = await reader.read();
	if (next.done) break;
	bytes += next.value.byteLength;
}
assert.equal(
	bytes,
	chunkSizes.reduce((a, b) => a + b, 0)
);
streamSender.close();
streamReceiver.close();
console.log("wire survives builtin and prototype replacement");
console.log(
	"stream attachment transfers 917504 bytes without framing or buffering limits"
);
