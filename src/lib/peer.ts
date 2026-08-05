function rtcDataChannelToStreams(
	dc: RTCDataChannel,
	{
		writeHighWaterMark = 1 << 20, // 1 MiB
		writeLowWaterMark = writeHighWaterMark >> 1,
		maxPendingReadBytes = 1 << 20, // hard cap; true inbound backpressure needs app-level flow control
	}: {
		writeHighWaterMark?: number;
		writeLowWaterMark?: number;
		maxPendingReadBytes?: number;
	} = {}
): [
	ReadableStream<Uint8Array<ArrayBuffer>>,
	WritableStream<Uint8Array<ArrayBuffer>>,
	Promise<void>,
] {
	dc.binaryType = "arraybuffer";
	dc.bufferedAmountLowThreshold = writeLowWaterMark;

	const channelError = () =>
		new DOMException("RTCDataChannel is not open", "NetworkError");

	const waitForOpen = () =>
		dc.readyState === "open"
			? Promise.resolve()
			: new Promise<void>((resolve, reject) => {
					const onOpen = () => done(resolve);
					const onClose = () =>
						done(() => {
							console.warn(
								"[node-worker] [peer] [rtc] datachannel closed before open"
							);
							reject(channelError());
						});
					const onError = (e: Event) =>
						done(() => {
							console.warn(
								"[node-worker] [peer] [rtc] datachannel errored before open",
								e
							);
							reject(channelError());
						});
					const done = (fn: () => void) => {
						dc.removeEventListener("open", onOpen);
						dc.removeEventListener("close", onClose);
						dc.removeEventListener("error", onError);
						fn();
					};
					dc.addEventListener("open", onOpen, { once: true });
					dc.addEventListener("close", onClose, { once: true });
					dc.addEventListener("error", onError, { once: true });
				});

	const waitForWritable = () =>
		dc.bufferedAmount <= writeLowWaterMark
			? Promise.resolve()
			: new Promise<void>((resolve, reject) => {
					const onLow = () => done(resolve);
					const onClose = () =>
						done(() => {
							console.warn(
								"[node-worker] [peer] [rtc] datachannel closed while waiting to drain"
							);
							reject(channelError());
						});
					const onError = (e: Event) =>
						done(() => {
							console.warn(
								"[node-worker] [peer] [rtc] datachannel errored while waiting to drain",
								e
							);
							reject(channelError());
						});
					const done = (fn: () => void) => {
						dc.removeEventListener("bufferedamountlow", onLow);
						dc.removeEventListener("close", onClose);
						dc.removeEventListener("error", onError);
						fn();
					};
					dc.addEventListener("bufferedamountlow", onLow, { once: true });
					dc.addEventListener("close", onClose, { once: true });
					dc.addEventListener("error", onError, { once: true });
				});

	let readController: ReadableStreamDefaultController<
		Uint8Array<ArrayBuffer>
	> | null = null;
	let readClosed = false;
	let pending: Uint8Array<ArrayBuffer>[] = [];
	let pendingBytes = 0;

	const maybeCloseReadable = () => {
		if (readClosed && pending.length === 0 && readController) {
			try {
				readController.close();
			} catch (e) {
				console.warn(
					"[node-worker] [peer] [rtc] failed to close readable (likely already errored/cancelled)",
					e
				);
			}
			readController = null;
		}
	};

	const drainReads = () => {
		if (!readController) return;
		try {
			while (pending.length && (readController.desiredSize ?? 0) > 0) {
				const chunk = pending.shift()!;
				pendingBytes -= chunk.byteLength;
				readController.enqueue(chunk);
			}
		} catch (e) {
			console.warn(
				"[node-worker] [peer] [rtc] failed to enqueue inbound chunk",
				e
			);
			readController = null;
			return;
		}
		maybeCloseReadable();
	};

	dc.addEventListener("message", (event) => {
		const chunk = new Uint8Array(event.data as ArrayBuffer);
		pending.push(chunk);
		pendingBytes += chunk.byteLength;

		if (pendingBytes > maxPendingReadBytes) {
			const err = new DOMException(
				"Readable side overflowed; RTCDataChannel cannot apply true inbound backpressure without app-level flow control",
				"QuotaExceededError"
			);
			console.warn("[node-worker] [peer] [rtc] inbound overflow", err);
			try {
				readController?.error(err);
			} catch (e) {
				console.warn(
					"[node-worker] [peer] [rtc] failed to error readable on overflow",
					e
				);
			}
			readController = null;
			dc.close();
			return;
		}

		drainReads();
	});

	dc.addEventListener("close", () => {
		console.warn("[node-worker] [peer] [rtc] datachannel closed");
		readClosed = true;
		maybeCloseReadable();
	});

	dc.addEventListener("error", (e) => {
		console.warn("[node-worker] [peer] [rtc] datachannel errored", e);
		try {
			readController?.error(channelError());
		} catch (e) {
			console.warn(
				"[node-worker] [peer] [rtc] failed to propagate error to readable",
				e
			);
		}
		readController = null;
	});

	const readable = new ReadableStream<Uint8Array<ArrayBuffer>>(
		{
			start(controller) {
				readController = controller;
				drainReads();
			},
			pull() {
				drainReads();
			},
			cancel(reason) {
				console.warn("[node-worker] [peer] [rtc] readable cancelled", reason);
				dc.close();
			},
		},
		{
			highWaterMark: writeHighWaterMark,
			size: (chunk) => chunk.byteLength,
		}
	);

	const writable = new WritableStream<Uint8Array<ArrayBuffer>>({
		async write(chunk) {
			while (dc.bufferedAmount > writeHighWaterMark) {
				await waitForWritable();
			}

			try {
				dc.send(chunk);
			} catch (e) {
				console.warn("[node-worker] [peer] [rtc] datachannel send failed", e);
				throw e;
			}

			if (dc.bufferedAmount > writeHighWaterMark) {
				await waitForWritable();
			}
		},
		close() {
			dc.close(); // no half-close in RTCDataChannel
		},
		abort(reason) {
			console.warn("[node-worker] [peer] [rtc] writable aborted", reason);
			dc.close();
		},
	});

	return [readable, writable, waitForOpen()];
}

/**
 * The `server.create`/`client.connect` credential, which is one field or the other.
 *
 * `authToken` is a puter token, and the server is listed under that user. `anonToken`
 * is any opaque string, and it is a *shared* address rather than a private credential:
 * the signaller matches a client to a server by the `(anonToken, port)` pair, so
 * whoever holds the token can reach the port. That is how an anonymous server is
 * reached at all — see `previewUrlFor` in the consuming app, and `puter.peer.connect`
 * in browser.js, which dials with `{ port, anonToken }` and no invite code.
 */
function credential(token: string, anon: boolean | undefined) {
	return anon ? { anonToken: token } : { authToken: token };
}

export async function handlePeerServe(
	token: string,
	port: number,
	signaller: string,
	iceServers: RTCIceServer[],
	anon?: boolean
): Promise<[string, MessagePort]> {
	let conns = new Map<string, RTCPeerConnection>();
	let code = `<port ${port}>`;

	let { port1: rx, port2: tx } = new MessageChannel();
	tx.start();

	let ws = new WebSocket(signaller);

	try {
		await new Promise<void>((res, rej) => {
			ws.onopen = () => res();
			ws.onerror = (e) => {
				console.warn("[node-worker] [peer] signaller error", e);
				rej(new Error("Signaller connection errored unexpectedly"));
			};
			ws.onclose = () =>
				rej(new Error("Signaller connection closed unexpectedly"));
		});

		ws.send(
			JSON.stringify({
				server: {
					create: {
						...credential(token, anon),
						port,
					},
				},
			})
		);

		let resolve = (_: any): void => {
			throw "unreachable";
		};

		ws.onmessage = async (e) => {
			let msg = JSON.parse(e.data).server;
			if (!msg) return;

			if (msg.create) {
				resolve(msg.create);
			} else if (msg.connect) {
				try {
					let id = msg.connect.id;
					let peer = new RTCPeerConnection({ iceServers });
					conns.set(id, peer);

					peer.onicecandidate = (e) => {
						if (!e.candidate) return;
						ws.send(
							JSON.stringify({
								server: {
									candidate: {
										id,
										candidate: e.candidate,
									},
								},
							})
						);
					};

					let datachannel = peer.createDataChannel("channel-1", {
						negotiated: true,
						id: 2,
					});
					let [readable, writable, ready] = rtcDataChannelToStreams(
						datachannel,
						{ maxPendingReadBytes: Infinity }
					);
					await ready;
					tx.postMessage(
						{ readable, writable },
						{ transfer: [readable, writable] }
					);
				} catch (err) {
					console.warn("[node-worker] [peer] failed to accept client", err);
				}
			} else if (msg.candidate) {
				let peer = conns.get(msg.candidate.id);
				if (!peer) return;

				await peer.addIceCandidate(msg.candidate.candidate);
			} else if (msg.offer) {
				let id = msg.offer.id;
				let peer = conns.get(id);
				if (!peer) return;

				await peer.setRemoteDescription(
					new RTCSessionDescription(msg.offer.offer)
				);
				let answer = await peer.createAnswer();
				await peer.setLocalDescription(answer);

				ws.send(
					JSON.stringify({
						server: {
							answer: {
								id,
								answer,
							},
						},
					})
				);
			}
		};

		code = await new Promise<string>((res, rej) => {
			resolve = (data) => {
				if (data.success) {
					// An invite code is how an *authenticated* server is reached, and the
					// signaller only mints one for that case — an anonymous create answers a
					// bare `{success:true}`, because its address is the `(anonToken, port)`
					// pair the client already has. So a missing code is success, not a
					// half-created server, and the caller keeps it only to report it.
					res(data.invitecode ?? "");
				} else {
					rej(new Error(`Signaller failed: ${data.error}`));
				}
			};
			setTimeout(() => rej(new Error("Server creation timed out")), 15000);
		});

		ws.onerror = (e) =>
			console.warn("[node-worker] [peer] signaller error", code, e);
		ws.onclose = () =>
			console.warn("[node-worker] [peer] signaller closed", code);

		tx.onmessage = () => {
			for (let [_, peer] of conns) {
				peer.close();
			}
			ws.close();
		};

		return [code, rx];
	} catch (e) {
		for (let [_, peer] of conns) {
			peer.close();
		}
		ws.close();
		throw e;
	}
}

export async function handlePeerConnect(
	token: string,
	code: string,
	signaller: string,
	iceServers: RTCIceServer[],
	anon?: boolean
): Promise<
	[
		ReadableStream<Uint8Array<ArrayBuffer>>,
		WritableStream<Uint8Array<ArrayBuffer>>,
	]
> {
	let peer = new RTCPeerConnection({
		iceServers,
	});

	let datachannel = peer.createDataChannel("channel-1", {
		negotiated: true,
		id: 2,
	});
	let [readable, writable, ready] = rtcDataChannelToStreams(datachannel, {
		maxPendingReadBytes: Infinity,
	});
	let ws = new WebSocket(signaller);

	try {
		// hack??
		code = code.toUpperCase();
		console.debug("[node-worker] [peer] invite code", code);
		await new Promise<void>((res, rej) => {
			ws.onopen = () => res();
			ws.onerror = (e) => {
				console.warn("[node-worker] [peer] signaller error", e);
				rej(new Error("Signaller connection errored unexpectedly"));
			};
			ws.onclose = () => {
				console.warn("[node-worker] [peer] signaller closed");
				rej(new Error("Signaller connection closed unexpectedly"));
			};
		});
		let wsErrorPromise = new Promise<void>((_, rej) => {
			ws.onerror = (e) => {
				console.warn("[node-worker] [peer] signaller error", e);
				rej(new Error("Signaller connection errored unexpectedly"));
			};
			ws.onclose = () => {
				console.warn("[node-worker] [peer] signaller closed");
				rej(new Error("Signaller connection closed unexpectedly"));
			};
		});

		ws.send(
			JSON.stringify({
				client: {
					connect: {
						...credential(token, anon),
						invitecode: code,
					},
				},
			})
		);

		peer.onicecandidate = (e) => {
			if (!e.candidate) return;
			ws.send(
				JSON.stringify({
					client: {
						candidate: {
							candidate: e.candidate,
						},
					},
				})
			);
		};

		let wsPromise = new Promise<void>((_, rej) => {
			ws.onmessage = async (e) => {
				let msg = JSON.parse(e.data).client;
				if (!msg) return;

				if (msg.answer) {
					await peer.setRemoteDescription(msg.answer.answer);
				} else if (msg.candidate) {
					if (msg.candidate.candidate) {
						await peer.addIceCandidate(msg.candidate.candidate);
					}
				} else if (msg.connect) {
					if (msg.connect.success) {
						let offer = await peer.createOffer();
						await peer.setLocalDescription(offer);
						ws.send(
							JSON.stringify({
								client: {
									offer: { offer },
								},
							})
						);
					} else {
						rej(new Error(`Signaller failed: ${msg.connect.error}`));
					}
				} else if (msg.disconnect) {
					rej(
						new Error(`Signaller sent a disconnect: ${msg.disconnect.reason}`)
					);
				}
			};
		});

		await Promise.race([ready, wsPromise, wsErrorPromise]);
		return [readable, writable];
	} catch (e) {
		datachannel.close();
		ws.close();
		throw e;
	}
}
