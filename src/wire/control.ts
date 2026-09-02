// The control op set: starting a worker, running a program, and the handful of
// notifications that go with it.
//
// These were `{type, to, reply}` messages until the formats merged. Nothing about them
// needed a second envelope — they are request/response with a correlation id, which is
// what every other kind already had — and having one meant two error shapes, two inflight
// maps and two ways to be told the peer went away.
//
// Async only. `execute` runs a whole program and the rest are notifications; there is
// nothing here worth parking a thread on, and `ctl.init` carries handles that bytes
// cannot express anyway.

import type { MountSnapshot, NodeFsCapabilities, VfsInit } from "./fs";

/**
 * Where the network comes from when there is no puter token.
 *
 * Both of these are otherwise minted by authenticated api calls — the wisp relay
 * credentials by `wisp/relay-token/create`, the peer identity by the signaller
 * against `authToken`. Supplying them directly is what makes an anonymous run
 * possible: the worker never touches api.puter.com, and the only two things it
 * loses are TURN relays (`peer/generate-turn` is authed, so ICE falls back to the
 * STUN list `peer/signaller-info` hands out unauthenticated) and puterfs, which
 * the host simply does not mount.
 */
export interface NodeNetInit {
	/**
	 * The relay address, dialed **as given**. Any wisp-compliant relay will do.
	 *
	 * Nothing is parsed out of it, which is what makes a wisp v1 URL
	 * (`wss://host/<relay-token>/`, as puter-js's `generateWispV1URL()` builds it)
	 * work by simply arriving intact: the token rides in the path and the relay
	 * reads it there.
	 */
	wispUrl?: string;
	/**
	 * A relay token to send over the wisp password extension (0x02), as the password
	 * with an empty user.
	 *
	 * Only for a relay that authenticates that way — which is how the puter relays
	 * are reached with credentials from `wisp/relay-token/create`, whose `server` and
	 * `token` map onto `wispUrl` and this. Omit it and no extension is negotiated at
	 * all, so put the token in `wispUrl`'s path instead if that is what your relay
	 * expects. Supplying it makes 0x02 **required**: a relay that does not offer the
	 * extension fails the handshake rather than proceeding unauthenticated.
	 */
	relayToken?: string;
	/**
	 * This peer's identity at the signaller, sent as `anonToken`. Any opaque
	 * string; a uuid is the obvious choice. Persist it and the peer keeps its
	 * identity across reloads.
	 */
	peerToken?: string;
}

/** Terminal dimensions, as `process.stdout.columns`/`rows`. */
export interface TtySize {
	columns?: number;
	rows?: number;
}

/**
 * One control operation.
 *
 * `ctl.init` is the bootstrap and the only message that arrives before the port exists,
 * so it travels over the raw `worker.postMessage` with the port itself as an attachment.
 * Everything after it goes over that port.
 */
export type ControlCall =
	| {
			op: "ctl.init";
			/** Empty for an anonymous run, in which case `net` supplies the network. */
			puter: string;
			net?: NodeNetInit;
			/** Where to load epoxy from. See `NodeWorkerOptions.epoxyBase`. */
			epoxyBase?: string;
			cwd: string;
			isTTY: boolean;
			size?: TtySize;
			keepalive?: boolean;
			/**
			 * Everything needed to reach the host filesystem, including the mount snapshot — so
			 * the worker has it in hand before any `fs` call is possible and there is no window
			 * in which a capability question has no answer.
			 */
			vfs: VfsInit;
	  }
	| { op: "ctl.cwd"; cwd: string }
	| {
			op: "ctl.execute";
			module: "esm" | "cjs";
			target: string;
			/**
			 * The complete `process.argv` for this run, `argv[0]` included. Defaults to
			 * `["node", target]`.
			 *
			 * A run's argv belongs to the run, not to the worker: it is what lets a package
			 * binary be driven the way a shell drives it, and the caller supplies the whole
			 * array rather than just the extras so that `argv0` and the script slot are
			 * under its control too.
			 */
			argv?: string[];
			/**
			 * Replaces `process.env`'s contents for this run — it is not merged into what is
			 * already there. The caller owns the environment, including the `TERM` the
			 * runtime otherwise defaults to, so that one run can never inherit a variable
			 * some earlier run happened to set.
			 */
			env?: Record<string, string>;
	  }
	/**
	 * The host's mount table changed.
	 *
	 * Pushed rather than polled because the worker needs it to answer questions that cannot
	 * wait for a round trip — whether a path's backend has a real positioned read, for one,
	 * which is asked in the middle of a read and decides whether to buffer the whole file. A
	 * stale snapshot can only pick a suboptimal strategy; it can never misroute an operation,
	 * since every call carries an absolute path the host resolves against its own
	 * authoritative table.
	 */
	| { op: "ctl.mounts"; mounts: MountSnapshot[] }
	/**
	 * Terminal state, from the side that can actually see the terminal.
	 *
	 * Re-sent on resize, because a CLI laying out progress output needs the real width.
	 * Omitted fields leave the current values alone.
	 */
	| { op: "ctl.setTty"; isTTY: boolean; size?: TtySize }
	/** The worker finished starting up. */
	| { op: "ctl.hi" }
	/** Raw-mode / echo changed on the worker's side, for the host to apply. */
	| { op: "ctl.tty"; isRaw?: boolean; echo?: boolean }
	/**
	 * `process.exit` was called. The worker is the process, so this is the process dying:
	 * the page terminates it on receipt.
	 *
	 * The worker throws immediately afterwards to stop the code following the `exit()` call
	 * from running, so it may well be gone before this message's reply could be delivered.
	 * Sending it is still worth doing — the reply is simply not waited on.
	 */
	| { op: "ctl.exit"; code: number };

export interface ControlResults {
	/**
	 * Whether the *synchronous* transport actually works, verified by one probe round trip
	 * during init rather than assumed.
	 *
	 * This is the design's safety valve. Every way service-worker interception can silently
	 * fail — a scope that does not cover the worker script, a policy blocking synchronous
	 * XHR, a worker that never activated — otherwise shows up as a *hang* at the first
	 * `readFileSync`. One probe turns all of them into a startup state with a reason
	 * attached.
	 */
	"ctl.init": { capabilities: NodeFsCapabilities };
	"ctl.cwd": null;
	/** `process.exitCode`, or the code passed to `process.exit`. */
	"ctl.execute": { exitCode: number };
	"ctl.mounts": null;
	"ctl.setTty": null;
	"ctl.hi": null;
	"ctl.tty": null;
	"ctl.exit": null;
}

export type ControlOpName = ControlCall["op"];
export type ControlResult<K extends ControlOpName> = ControlResults[K];
