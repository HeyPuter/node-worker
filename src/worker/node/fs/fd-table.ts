// Global numeric file-descriptor registry.
//
// Node hands out integer fds from a single process-wide space shared by the
// sync, callback, and promise APIs. We mirror that with one counter and one
// table. The async family (fs.open / fs.read / ...) stores `FileHandle`s here;
// the sync family (fs.openSync / fs.readSync / ...) stores `SyncFileHandle`s.
// Both back onto puterfs's whole-file read/write, just async vs. sync.
//
// This module intentionally imports nothing from the handle modules so it can
// be a dependency of both without creating an import cycle.

let nextFd = 10;

export function allocFd(): number {
	return nextFd++;
}

export const fdTable = new Map<number, unknown>();
