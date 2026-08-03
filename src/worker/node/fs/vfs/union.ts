// Two providers stacked over one subtree.
//
// This is where layering lives, rather than in the mount table — the table stays
// one-provider-per-root and trivially correct, and the "which layer answers"
// question is a single independently testable module.
//
// The shape the zip mount will want: the archive as a read-only *lower* layer with
// real puterfs as the writable *upper* one, so `node_modules` reads come out of the
// zip while anything a build writes into it (vite's dependency optimizer parking
// pre-bundled deps under `node_modules/.vite`) lands in real storage and survives a
// restart.
//
// ## No whiteouts
//
// There is nowhere to record "this lower-layer path was deleted": puterfs has no
// such concept and a sidecar marker file inside a user's node_modules is worse than
// the limitation. Two consequences, both intended for the archive case and both
// wrong for a general-purpose overlay:
//
//   - deleting an upper file that also exists below makes the lower version
//     reappear;
//   - deleting a lower-only file reports EROFS.

import type { Plan } from "../plan";
import type { FsProvider, Listing, OpCtx, ReaddirOpts } from "./provider";
import { createFsError, type FsEntry } from "../util";
import nodePath from "../../path";

export type WriteTarget =
	/** Everything is written to the upper layer. The archive mount. */
	| "upper"
	/**
	 * Written to whichever layer already holds the path, else the lower one. The
	 * root mount: a sparse memory layer shadows real files where it has them, but
	 * writing to an ordinary path still writes to ordinary storage.
	 */
	| "existing";

function* has(
	provider: FsProvider,
	ctx: OpCtx,
	path: string
): Plan<FsEntry | undefined> {
	try {
		return yield* provider.stat(ctx, path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw err;
	}
}

export function unionProvider(
	upper: FsProvider,
	lower: FsProvider,
	write: WriteTarget
): FsProvider {
	function roFail(ctx: OpCtx): never {
		throw createFsError(
			"EROFS",
			-30,
			"read-only file system",
			ctx.syscall,
			ctx.reportPath
		);
	}

	/** Which layer a mutation should go to, and whether that is allowed at all. */
	function* writeLayer(ctx: OpCtx, path: string): Plan<FsProvider> {
		if (write === "upper") return upper;
		if (yield* has(upper, ctx, path)) return upper;
		return lower;
	}

	return {
		name: `union(${upper.name},${lower.name})`,

		*stat(ctx, path): Plan<FsEntry> {
			const up = yield* has(upper, ctx, path);
			if (!up) return yield* lower.stat(ctx, path);

			// A directory present in both layers is *one* directory — the union shows
			// the merged contents either way, so the only question is whose timestamps
			// to report, and the answer is the layer that primarily owns the data.
			// With `write: "existing"` the upper layer is a sparse overlay whose
			// directories exist only as scaffolding to hold a shadowing file, and
			// reporting their creation time in place of the real directory's mtime
			// would be actively misleading.
			if (up.isDir && write === "existing") {
				const low = yield* has(lower, ctx, path);
				if (low && low.isDir) return low;
			}
			return up;
		},

		*readdir(ctx, path, opts?: ReaddirOpts): Plan<Listing> {
			let upList: Listing | undefined;
			let lowList: Listing | undefined;
			let lowErr: unknown;
			try {
				upList = yield* upper.readdir(ctx, path, opts);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			}
			try {
				lowList = yield* lower.readdir(ctx, path, opts);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
				lowErr = err;
			}
			if (!upList && !lowList) {
				// Neither layer has it. Rethrow the error already in hand rather than
				// asking again — the lower layer is usually a network filesystem, and
				// re-running the listing to reproduce its ENOENT would double the cost
				// of every miss.
				throw lowErr;
			}

			// Merge by path, upper winning. Keyed on the full entry path rather than
			// the basename so a recursive listing dedupes correctly at every depth.
			const merged = new Map<string, FsEntry>();
			for (const e of lowList?.entries ?? []) merged.set(e.path, e);
			for (const e of upList?.entries ?? []) merged.set(e.path, e);
			return {
				entries: [...merged.values()],
				// Only exhaustive if both halves were.
				complete: (upList?.complete ?? true) && (lowList?.complete ?? true),
			};
		},

		*readFile(ctx, path): Plan<Buffer> {
			if (yield* has(upper, ctx, path)) return yield* upper.readFile(ctx, path);
			return yield* lower.readFile(ctx, path);
		},

		*readRange(ctx, path, offset, length): Plan<Buffer> {
			const target = (yield* has(upper, ctx, path)) ? upper : lower;
			if (target.readRange) {
				return yield* target.readRange(ctx, path, offset, length);
			}
			const whole = yield* target.readFile(ctx, path);
			return whole.subarray(offset, offset + length);
		},

		*writeFile(ctx, path, data): Plan<void> {
			const target = yield* writeLayer(ctx, path);
			if (target === upper && write === "upper") {
				// The upper layer may not have the containing directory yet — the whole
				// point of the archive case is that `node_modules/...` exists only in
				// the lower layer until something writes there. One extra round trip,
				// and the cache makes it zero after the first.
				yield* upper.mkdir(ctx, nodePath.dirname(path), { recursive: true });
			}
			yield* target.writeFile(ctx, path, data);
		},

		*mkdir(ctx, path, opts): Plan<string | undefined> {
			const target = write === "upper" ? upper : yield* writeLayer(ctx, path);
			return yield* target.mkdir(ctx, path, opts);
		},

		*rm(ctx, path, opts): Plan<void> {
			if (yield* has(upper, ctx, path)) {
				yield* upper.rm(ctx, path, opts);
				return;
			}
			// Present only below, where nothing can be removed and nothing can record
			// that it was.
			if (yield* has(lower, ctx, path)) {
				if (write === "upper") {
					if (opts.force) return;
					roFail(ctx);
				}
				yield* lower.rm(ctx, path, opts);
				return;
			}
			if (opts.force) return;
			yield* upper.rm(ctx, path, opts); // for its ENOENT
		},

		*rename(ctx, from, to): Plan<void> {
			if (yield* has(upper, ctx, from)) {
				yield* upper.rename(ctx, from, to);
				return;
			}
			if (write === "upper" && (yield* has(lower, ctx, from))) roFail(ctx);
			yield* lower.rename(ctx, from, to);
		},

		*utimes(ctx, path, atimeMs, mtimeMs): Plan<boolean> {
			if (yield* has(upper, ctx, path)) {
				return yield* upper.utimes(ctx, path, atimeMs, mtimeMs);
			}
			if (write === "upper" && (yield* has(lower, ctx, path))) roFail(ctx);
			return yield* lower.utimes(ctx, path, atimeMs, mtimeMs);
		},

		*pin(ctx, path): Plan<unknown> {
			const target = (yield* has(upper, ctx, path)) ? upper : lower;
			if (!target.pin) return undefined;
			return yield* target.pin(ctx, path);
		},

		// statfs and openRead are intentionally absent: capacity belongs to whichever
		// backend actually stores bytes, and the facade derives a stream from
		// `readFile` when a provider can't do better.
	};
}
