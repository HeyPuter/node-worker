// Watch events synthesized from this worker's own mutations.
//
// The api echoes every write back over the socket.io feed, so watchers would
// eventually see our own changes anyway — but only after a round trip, and only
// while the socket is up. Emitting locally the moment a call succeeds is what
// makes write-then-observe (chokidar's `awaitWriteFinish`, a dev server's HMR
// trigger) feel immediate.
//
// Echoes are deliberately NOT deduplicated; see the comment on
// `emitLocalFsEvent` in ../../fsevents.ts for why an extra event is the cheap
// failure mode here.

import { emitLocalFsEvent } from "../../fsevents";

/**
 * A file's contents changed. Used for writes even when the file was just
 * created: nothing on the write path stats first, so we can't tell `added` from
 * `updated` without an extra round trip. The socket echo that follows carries
 * the api's own classification.
 */
export function localWrite(path: string) {
	emitLocalFsEvent({ kind: "updated", path, isDir: false });
}

export function localAdd(path: string, isDir = false) {
	emitLocalFsEvent({ kind: "added", path, isDir });
}

export function localRemove(path: string, isDir = false) {
	emitLocalFsEvent({ kind: "removed", path, isDir });
}

export function localMove(oldPath: string, path: string, isDir = false) {
	emitLocalFsEvent({ kind: "moved", path, oldPath, isDir });
}

/**
 * mkdir, including the implicitly-created parents a recursive mkdir reports in
 * `parent_dirs_created`. node's watchers see each new directory, so emitting
 * only the leaf would hide the rest of the chain.
 */
export function localMkdir(path: string, res: any) {
	let parents = res?.parent_dirs_created;
	if (Array.isArray(parents)) {
		for (let parent of parents) {
			if (typeof parent === "string" && parent !== path) localAdd(parent, true);
		}
	}
	localAdd(path, true);
}
