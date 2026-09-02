// Frame in, frame out, for process ops. The mirror of ../vfs/dispatch.ts.
//
// Both transports land here on the same bytes: the blocking `XMLHttpRequest` a worker uses for
// `spawnSync`, and the `postMessage` it uses for everything else. One implementation, so a
// framing or error-shape bug cannot exist on one and not the other.

import { toWireError } from "../../wire/error";
import { decodeFrame } from "../../wire/frame";
import { primaryParts } from "../../wire/pack";
import { KIND_PROCESS } from "../../wire/kinds";
import { encodeReply } from "../../wire/router";
import type { WireReply } from "../../wire/message";
import type { ProcessProvider } from "../../process/provider";
import type { ProcessCall, ProcessRequest } from "../../wire/process";

// Part lengths are derived by `encodeReply`, not written out here. They used to be set by
// hand at each call site that had bytes to send, which is one transcription per op and one
// chance each to disagree with the payload actually attached.
function reply(header: WireReply, parts?: Uint8Array[]): Uint8Array {
	return encodeReply(KIND_PROCESS, header, parts);
}

export async function handleProcessFrame(
	provider: ProcessProvider | undefined,
	frame: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
	let request: ProcessRequest;
	let parts: Uint8Array[];
	try {
		const decoded = decodeFrame<ProcessRequest>(frame);
		request = decoded.header;
		parts = primaryParts(decoded.header, decoded.parts);
	} catch (err) {
		// No seq to echo, so answer with one anyway: a worker parked on a reply that never
		// comes is worse than a caller getting an error it can report.
		return reply({
			seq: 0,
			result: { ok: false, error: toWireError(err, "spawn") },
		});
	}

	const { seq, call } = request;
	try {
		if (!provider) {
			throw Object.assign(
				new Error(
					"no process provider is registered — pass `process` to NodeWorker.create, " +
						"or call worker.registerProcessProvider()"
				),
				{ code: "ENOSYS" }
			);
		}

		switch (call.op) {
			case "proc.probe":
				return reply({
					seq,
					result: { ok: true, value: { provider: provider.name } },
				});

			case "proc.spawn":
				return reply({
					seq,
					result: {
						ok: true,
						value: await provider.spawn(call.ctx, call.request),
					},
				});

			case "proc.poll": {
				const events = await provider.poll(call.ctx, call.pid);
				/*
				 * The bytes ride in the payload and the header only says what each event *is*,
				 * in the same order. A child that prints a megabyte would otherwise put that
				 * megabyte through `JSON.stringify` on the way out and `JSON.parse` on the way
				 * in, per poll.
				 */
				const bytes: Uint8Array[] = [];
				const described = events.map((e) => {
					if (e.kind === "exit") {
						return {
							kind: "exit" as const,
							status: e.status,
							signal: e.signal,
						};
					}
					bytes.push(e.bytes);
					return { kind: e.kind };
				});
				return reply(
					{ seq, result: { ok: true, value: { events: described } } },
					bytes
				);
			}

			case "proc.write":
				await provider.write(call.ctx, call.pid, parts[0] ?? new Uint8Array(0));
				return reply({ seq, result: { ok: true, value: undefined } });

			case "proc.endStdin":
				await provider.endStdin(call.ctx, call.pid);
				return reply({ seq, result: { ok: true, value: undefined } });

			case "proc.kill":
				await provider.kill(call.ctx, call.pid, call.signal);
				return reply({ seq, result: { ok: true, value: undefined } });

			case "proc.spawnSync": {
				const result = await provider.spawnSync(call.ctx, {
					...call.request,
					input: parts[0],
				});
				const out = [result.stdout, result.stderr];
				return reply(
					{
						seq,
						result: {
							ok: true,
							value: {
								status: result.status,
								signal: result.signal,
								error: result.error,
							},
						},
					},
					out
				);
			}

			default: {
				const unknown = call as { op: string };
				throw Object.assign(new Error(`unknown process op ${unknown.op}`), {
					code: "ENOSYS",
				});
			}
		}
	} catch (err) {
		return reply({
			seq,
			result: { ok: false, error: toWireError(err, syscallOf(call)) },
		});
	}
}

/** The syscall name an error should carry, which is the caller's word for what it asked. */
function syscallOf(call: ProcessCall): string {
	return "ctx" in call ? call.ctx.syscall : "spawn";
}
