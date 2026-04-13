import nodeBuffer from "./buffer";
import nodeStream from "./stream";

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
