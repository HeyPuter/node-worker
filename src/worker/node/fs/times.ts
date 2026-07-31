// Shared `utimes` machinery.
//
// The only timestamp api puter exposes is `POST /touch`, whose fields are
// `set_{accessed,modified,created}_to_now` — there is no way to write an
// arbitrary value. So a request for approximately-now is honored for real and
// anything else is a no-op, and that decision lives here rather than being
// repeated by `promises.utimes`, `utimesSync` and `FileHandle#utimes`.

import { decode, fetchPuter } from "../../puter";
import { isEffectivelyNow, toEpochMs, translatePuterError } from "./util";
import { localWrite } from "./local-events";

/**
 * Issues the `/touch` if the requested times are close enough to now to be
 * representable. Returns false when nothing was sent, which is the caller's cue
 * to validate the path some other way (an existence probe) so a `utimes` on a
 * missing file still reports ENOENT.
 */
export async function applyUtimes(
	path: string,
	atime: unknown,
	mtime: unknown
): Promise<boolean> {
	let setAccessed = isEffectivelyNow(toEpochMs(atime, "utime"));
	let setModified = isEffectivelyNow(toEpochMs(mtime, "utime"));
	if (!setAccessed && !setModified) return false;

	let [ok, u8array] = await fetchPuter("touch", {
		path,
		set_accessed_to_now: setAccessed,
		set_modified_to_now: setModified,
		create_missing_parents: false,
	});
	if (!ok) {
		let res = decode(u8array);
		throw (
			translatePuterError(res.code, "utime", path) ?? new Error(res.message)
		);
	}
	localWrite(path);
	return true;
}
