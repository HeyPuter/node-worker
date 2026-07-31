// Global numeric file-descriptor registry.
//
// Node hands out integer fds from a single process-wide space shared by the sync,
// callback, and promise APIs, and an fd from any of them works with all of them.
// One counter and one table, holding one kind of handle — the sync and async
// families used to store different classes here and reject each other's fds with
// EBADF, which node never does.
//
// `nextFd` starting at 10 is load-bearing beyond leaving room for stdio: the
// esbuild-wasm shim (node-worker-test/src/shims/esbuild-wasm.cjs) bridges Go's
// filesystem calls by dispatching on the fd number — 0/1/2 are its own stdio
// protocol and anything >= 10 is forwarded to us. Lowering this would break vite's
// dependency optimizer.
//
// This module intentionally imports nothing, so it can be a dependency of both the
// handle and everything that looks handles up without creating a cycle. Hence the
// structural type rather than importing FileHandle.

let nextFd = 10;

export function allocFd(): number {
	return nextFd++;
}

/** The shape the table guarantees. The only implementation is `FileHandle`. */
export interface HandleLike {
	readonly fd: number;
}

export const fdTable = new Map<number, HandleLike>();
