// @ts-ignore
import events from "node-external:events";
let nodeEvents = events as typeof import("node:events");
// @ts-ignore
import stream from "node-external:stream";
let nodeStream = stream as typeof import("node:stream");
// @ts-ignore
import buffer from "node-external:buffer";
let nodeBuffer = buffer as typeof import("node:buffer");
// @ts-ignore
import path from "node-external:path";
let nodePath = path as typeof import("node:path");
// @ts-ignore
import util from "node-external:util";
let nodeUtil = util as typeof import("node:util");
// @ts-ignore
import zlib from "node-external:zlib";
let nodeZlib = zlib as typeof import("node:zlib");

export function streamToBuffer(
	stream: InstanceType<typeof nodeStream.Readable>
): Promise<Buffer> {
	return new Promise((res, rej) => {
		let buf = nodeBuffer.Buffer.alloc(0);
		stream.on("data", (data) => {
			buf = nodeBuffer.Buffer.concat([buf, data]);
		});
		stream.on("end", () => {
			res(buf);
		});
		stream.on("error", (e) => rej(e));
	});
}

type Promisified = (...args: any[]) => Promise<any>;
type Depromisified<T extends Promisified> = T extends (
	...args: infer Args
) => Promise<infer Ret>
	? (
			...args: [
				...Args,
				callback: Ret extends void
					? (err: Error | undefined) => void
					: (err: Error | undefined, ret: Ret | undefined) => void,
			]
		) => void
	: never;
type DepromisifiedObject<T extends Record<string, Promisified>> = {
	[K in keyof T]: Depromisified<T[K]>;
};

export function depromisify<T extends Record<string, Promisified>>(
	obj: T
): DepromisifiedObject<T> {
	return Object.fromEntries(
		Object.entries(obj).map(([k, v]) => [
			k,
			(...args: any[]) => {
				let cb = args.pop();
				v(...args)
					.then((r) => cb(undefined, r))
					.catch((e) => cb(e, undefined));
			},
		])
	) as any;
}

export {
	nodeEvents as events,
	nodeStream as stream,
	nodeBuffer as buffer,
	nodePath as path,
	nodeUtil as util,
	nodeZlib as zlib,
};
