// The puterfs backend.
//
// One copy of each request shape. Before this existed the same calls were written
// out in ../sync.ts, ../promises.ts, ../handle.ts and ../handle-sync.ts — four
// copies of the whole-file upload, three of the stat, two each of everything else
// — kept in step only by hand. They are plans now, so the sync fs and the async fs
// drive the same code.
//
// Nothing here touches ../classes.ts: `Stats`/`Dirent` are node's shapes and
// belong to the fs surface, while this layer speaks `FsEntry`. That is a layering
// rule and a cycle guard at the same time.

import nodePath from "../../path";
import nodeBuffer from "../../buffer";
import { getRandomId } from "../../../puter";
import type { Plan } from "../plan";
import type { FsProvider, Listing, OpCtx, ReaddirOpts } from "./provider";
import {
	isEffectivelyNow,
	normalizeFsEntry,
	readUrl,
	statRequest,
	translatePuterError,
	type FsEntry,
} from "../util";
import { readdirPagesPlan, readdirTreePlan } from "../readdir-recursive";
import {
	localAdd,
	localMkdir,
	localMove,
	localRemove,
	localWrite,
} from "../local-events";

let Buffer = nodeBuffer.Buffer;

/**
 * Turns a non-`ok` response into the node error for it. Every failure path in
 * this file goes through here so the mapping lives in one place.
 */
function fail(body: any, ctx: OpCtx): never {
	throw (
		translatePuterError(body?.code, ctx.syscall, ctx.reportPath) ??
		new Error(body?.message ?? `${ctx.syscall} failed on ${ctx.reportPath}`)
	);
}

/**
 * The multipart body for a whole-file write. puterfs has no partial-write
 * primitive — `POST /batch` with `op: "write"` and `overwrite: true` replacing the
 * entire file is the only way to change one — so this is the sole write path, and
 * every caller that looks like an incremental write is buffering to reach it.
 */
function writeBody(path: string, data: Buffer) {
	let name = nodePath.basename(path);
	let parent = nodePath.dirname(path);
	return (form: FormData) => {
		let opId = getRandomId();
		form.append("operation_id", opId);
		form.append(
			"fileinfo",
			JSON.stringify({
				name,
				type: "application/octet-stream",
				size: data.byteLength,
			})
		);
		form.append(
			"operation",
			JSON.stringify({
				op: "write",
				dedupe_name: false,
				overwrite: true,
				operation_id: opId,
				path: parent,
				name,
				item_upload_id: 0,
			})
		);
		form.append("file", new File([data as unknown as BlobPart], name));
	};
}

export const puterProvider: FsProvider = {
	name: "puter",

	*stat(ctx, path): Plan<FsEntry> {
		let res = yield { url: "stat", body: statRequest(path) };
		let body = res.json();
		if (!res.ok) fail(body, ctx);
		return normalizeFsEntry(body);
	},

	*readdir(ctx, path, opts?: ReaddirOpts): Plan<Listing> {
		// `syscall` is threaded through so a failure deep inside the paging loop
		// still reports the operation the caller actually invoked.
		if (opts?.recursive && opts.depth === undefined) {
			// No depth given means "everything", which needs the re-rooting horizon
			// walk rather than a single capped request.
			let entries = yield* readdirTreePlan(path);
			return { entries, complete: true };
		}
		return yield* readdirPagesPlan(path, {
			recursive: opts?.recursive,
			depth: opts?.depth,
			maxEntries: opts?.maxEntries,
			syscall: ctx.syscall,
		});
	},

	*readFile(ctx, path): Plan<Buffer> {
		let res = yield { url: readUrl(path) };
		if (!res.ok) fail(res.json(), ctx);
		return Buffer.from(res.bytes.buffer, res.bytes.byteOffset, res.bytes.byteLength);
	},

	// Ranged read via the HTTP `Range` header.
	//
	// NOT `?offset=&byte_count=`: the api's `/read` handler ignores those query
	// parameters and answers with the *whole file*, which is worse than an error —
	// a caller reading at a non-zero position would silently get bytes from offset
	// 0, and a stream would never see EOF because every read returns data.
	//
	// The cost is a CORS preflight, since a custom header makes this a non-simple
	// GET. Only positioned reads pay it; whole-file reads go through `readFile`.
	*readRange(ctx, path, offset, length): Plan<Buffer> {
		let end = offset + length - 1;
		let res = yield {
			url: readUrl(path),
			headers: { Range: `bytes=${offset}-${end}` },
		};
		if (!res.ok) {
			// 416 means the range starts at or past EOF, which for a positioned read
			// is simply "no bytes there" — what libuv reports as 0.
			if (res.status === 416) return Buffer.alloc(0);
			fail(res.json(), ctx);
		}
		// A 200 means the server ignored the range and sent everything; slicing
		// keeps this correct if that ever regresses.
		let bytes =
			res.status === 206 ? res.bytes : res.bytes.subarray(offset, offset + length);
		return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	},

	*writeFile(ctx, path, data): Plan<void> {
		let res = yield { url: "batch", body: writeBody(path, data) };
		// `/batch` reports per-operation success in its body and answers 218 when any
		// operation failed, so the transport-level `ok` is not the whole story.
		let result = res.json()?.results?.[0];
		if (result?.success === false) fail(result, ctx);
		if (!res.ok && !result) fail(res.json(), ctx);
		// This is the moment the file changes as far as puterfs is concerned.
		localWrite(path);
	},

	*mkdir(ctx, path, opts): Plan<string | undefined> {
		let res = yield {
			url: "mkdir",
			body: {
				parent: nodePath.dirname(path),
				path: nodePath.basename(path),
				overwrite: opts.recursive,
				dedupe_name: false,
				create_missing_parents: opts.recursive,
			},
		};
		let body = res.json();
		if (!res.ok) fail(body, ctx);
		localMkdir(path, body);
		// node returns the first directory created, or undefined. puterfs doesn't
		// reliably report it, so guard rather than throw.
		return opts.recursive ? body?.parent_dirs_created?.[0] : undefined;
	},

	*rm(ctx, path, opts): Plan<void> {
		let res = yield {
			url: "delete",
			body: {
				paths: [path],
				recursive: opts.recursive,
				descendants_only: false,
			},
		};
		if (!res.ok) {
			// `force` swallows the failure — but nothing was removed, so no event.
			if (opts.force) return;
			fail(res.json(), ctx);
		}
		localRemove(path, opts.recursive);
	},

	*rename(ctx, from, to): Plan<void> {
		let res = yield {
			url: "move",
			body: {
				source: from,
				destination: nodePath.dirname(to),
				new_name: nodePath.basename(to),
				overwrite: false,
				create_missing_parents: false,
			},
		};
		if (!res.ok) fail(res.json(), ctx);
		localMove(from, to);
	},

	*copyFile(ctx, from, to, opts): Plan<void> {
		let res = yield {
			url: "copy",
			body: {
				source: from,
				destination: nodePath.dirname(to),
				new_name: nodePath.basename(to),
				overwrite: opts.overwrite,
				dedupe_name: false,
			},
		};
		if (!res.ok) fail(res.json(), ctx);
		localAdd(to);
	},

	// The only timestamp api is `POST /touch`, whose fields are
	// `set_{modified,accessed,created}_to_now` — there is no field for a value. So
	// "approximately now" is the only representable request, and anything else is
	// reported as not applied rather than faked.
	//
	// The tolerance covers the gap between a caller reading the clock and this
	// issuing the request, which is what makes `touch(1)`-style callers work.
	*utimes(ctx, path, atimeMs, mtimeMs): Plan<boolean> {
		let setAccessed = isEffectivelyNow(atimeMs);
		let setModified = isEffectivelyNow(mtimeMs);
		if (!setAccessed && !setModified) return false;

		let res = yield {
			url: "touch",
			body: {
				path,
				set_accessed_to_now: setAccessed,
				set_modified_to_now: setModified,
				create_missing_parents: false,
			},
		};
		if (!res.ok) fail(res.json(), ctx);
		localWrite(path);
		return true;
	},

	*statfs(ctx): Plan<{ used: number; capacity: number }> {
		// `body: {}` rather than omitting it — an empty JSON POST, which is what
		// `/df` expects. Presence of `body` is what selects POST over GET.
		let res = yield { url: "df", body: {} };
		let body = res.json();
		if (!res.ok) fail(body, ctx);
		return body;
	},

	// puterfs exposes no inode, so there is nothing to pin: a handle here is
	// path-based, which is what the existing implementation already assumed.
	*pin(): Plan<unknown> {
		return undefined;
	},

	// `openRead` is deliberately NOT implemented yet. Declaring it as a stub that
	// throws would be worse than leaving it off: the layer probes for the method to
	// decide whether a provider can stream, so a present-but-throwing one turns
	// every createReadStream into an error instead of falling back. ../streams.ts
	// still owns its own streamed-body path until that moves here.
};
