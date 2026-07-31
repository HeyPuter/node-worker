// Shared `utimes` argument handling.
//
// Converting node's time arguments (a number of *seconds*, a numeric string, a
// Date, or NaN/Infinity meaning "now") to epoch milliseconds is the same work for
// `utimesSync`, `promises.utimes` and `FileHandle#utimes`, so it lives here once
// rather than three times.
//
// What is *representable* is not decided here — that belongs to the backend, and
// puterfs's answer is "only now" (see `utimes` in ./vfs/puter.ts). This just
// converts and forwards, and passes the provider's verdict back up: `false` means
// nothing was written, which is the caller's cue to validate the path some other
// way so a `utimes` on a missing file still reports ENOENT.

import type { Plan } from "./plan";
import { toEpochMs } from "./util";
import { ctx, vfs } from "./vfs";

export function* utimesPlan(
	path: string,
	atime: unknown,
	mtime: unknown
): Plan<boolean> {
	return yield* vfs.utimes(
		ctx("utime", path),
		path,
		toEpochMs(atime, "utime"),
		toEpochMs(mtime, "utime")
	);
}
