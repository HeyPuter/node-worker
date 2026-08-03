// process.exit.
//
// There is no way to stop a worker from inside it, so exiting is a two-part move:
// tell the page (which terminates us — the worker *is* the process, so its death is
// the process's) and throw, so that the statements after the `exit()` call do not
// run in the window before termination arrives. Neither half is sufficient alone.
// The throw is not the mechanism, it is only what makes the wait observable-free.
//
// Kept in its own module, importing nothing but ./conn, because node/process.ts
// imports it: process is `inject`-ed into upstream node-core, so anything it reaches
// for has to be free of the node subgraph or the cycle its own header warns about
// closes.

import { send } from "./conn";

/**
 * Unwinds the current run after `process.exit`. Caught by the `execute` handler,
 * which reports the code instead of the error.
 */
export class ProcessExit extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExit";
	}
}

export function requestExit(code: number): never {
	// Fire-and-forget: the page terminates us on receipt, so this reply may never be
	// delivered. Swallowing the rejection keeps termination from surfacing as an
	// unhandled promise rejection on the way out.
	void send("exit", { code }).catch(() => {});
	throw new ProcessExit(code);
}
