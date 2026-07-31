import nodeBuffer from "../buffer";
import nodePath from "../path";
import { Dirent } from "./classes";
import type { Plan } from "./plan";
import {
	cacheBust,
	normalizeFsEntry,
	translatePuterError,
	type FsEntry,
} from "./util";

let Buffer = nodeBuffer.Buffer;

// Directory listing against the api's `/fs/readdir` route, which can return a
// whole subtree in one paged call (`recursive` + `depth`).
//
// The paging, depth-horizon and error handling live here as a *generator* that
// yields request descriptors and receives responses, rather than as two copies
// of the same loop in `promises.ts` and `sync.ts`. Those two used to be
// byte-identical and this logic is fiddly enough that they would drift. Callers
// hand the plan to `runSync` or `runAsync` (./driver.ts); the resolver
// (`module/resolve.ts`) drives it synchronously too.
//
// This was the first operation written this way, and the request/response types
// it used to declare here are now the general ones in ./plan.ts.

// The api clamps `depth` to this (MAX_READDIR_DEPTH in the backend's
// FSController) and silently ignores anything larger. node's recursive readdir
// has no depth limit, so we treat it as a horizon: any directory that comes back
// at exactly this depth is re-rooted and walked again.
export const MAX_DEPTH = 10;

// The api caps `limit` at 10k and defaults to 1k. Responses are parsed with a
// single non-streaming `JSON.parse`, so oversized pages cost a big transient
// string; 5k is a compromise between that and the per-request round trip.
const PAGE_LIMIT = 5000;

export interface ReaddirPage {
	/** Every descendant returned for this root, across all pages. */
	entries: FsEntry[];
	/**
	 * Whether paging ran to completion. A walk cut short by `maxEntries` returns
	 * a valid prefix of the listing but is *not* an exhaustive one — callers that
	 * derive "this directory contains nothing else" from a listing must check
	 * this first.
	 */
	complete: boolean;
}

interface PagesOptions {
	recursive?: boolean;
	depth?: number;
	/** Stop paging once this many entries have accumulated. */
	maxEntries?: number;
	/** Reported in the thrown error; node uses "scandir" for readdir. */
	syscall?: string;
}

function readdirUrl(
	path: string,
	opts: {
		recursive?: boolean;
		depth?: number;
		cursor?: string;
		includeTotal?: boolean;
	}
): string {
	let q = new URLSearchParams();
	q.set("path", path);
	if (opts.recursive) {
		q.set("recursive", "true");
		q.set("depth", String(opts.depth ?? MAX_DEPTH));
	}
	if (opts.includeTotal) q.set("includeTotal", "true");
	q.set("limit", String(PAGE_LIMIT));
	// Always present, empty on the first page. Sending `cursor` at all is what
	// opts into the `{items, cursor?}` envelope; without it a non-recursive
	// listing comes back as a bare array that the server has already truncated
	// to `limit` with no way to ask for the rest.
	q.set("cursor", opts.cursor ?? "");
	// Cache-busted for the same reason `read` is (see `readUrl` in ./util): a
	// silently stale listing is a miserable bug to chase and it costs one query
	// parameter. `/fs/readdir` sends no validator at all, so heuristic caching
	// shouldn't even kick in here — this is belt-and-braces.
	q.set("_", cacheBust());
	// GET rather than POST: it carries the token as `?auth_token=` (see
	// puter.ts `handleAuth`), which keeps it a CORS-simple request and skips the
	// preflight. That halves the blocking round trips on the sync path.
	return `fs/readdir?${q}`;
}

// A recursive response is always the `{items, cursor?, total?}` envelope; the
// non-recursive form is a bare array. Both reduce to this.
function toPage(body: any): {
	items: any[];
	cursor: string | undefined;
	total: number | undefined;
} {
	if (Array.isArray(body))
		return { items: body, cursor: undefined, total: undefined };
	return {
		items: body?.items ?? [],
		cursor: body?.cursor ?? undefined,
		total: typeof body?.total === "number" ? body.total : undefined,
	};
}

export interface EncodeOptions {
	encoding?: BufferEncoding | "buffer" | null;
	withFileTypes?: boolean;
	recursive?: boolean;
}

/**
 * Turn one entry into what `readdir` actually yields, per
 * `node_core/lib/fs.js` (`handleDirents` / `handleFilePaths`):
 *
 * - `withFileTypes`: a `Dirent` whose `name` is the *base* name and whose
 *   `parentPath` is the full containing directory.
 * - `recursive` without `withFileTypes`: the path **relative to the directory
 *   that was read** (`"a/b.txt"`), not the base name.
 * - otherwise: the base name.
 */
export function encodeEntry(
	entry: FsEntry,
	root: string,
	options: EncodeOptions
): any {
	let raw =
		options.recursive && !options.withFileTypes
			? nodePath.relative(root, entry.path)
			: entry.name;

	let nameBuf = Buffer.from(raw, "utf8");
	let name: string | Buffer =
		options.encoding === "buffer"
			? nameBuf
			: nameBuf.toString(options.encoding || undefined);

	return options.withFileTypes ? new Dirent(name, entry) : name;
}

/**
 * How many path segments `p` sits below `root`; direct children are 1, and -1
 * means `p` isn't under `root` at all.
 *
 * The trailing slash on the prefix is load-bearing: without it `/foo-bar` reads
 * as a descendant of `/foo`.
 */
export function relDepth(root: string, p: string): number {
	let prefix = root === "/" ? "/" : root + "/";
	if (!p.startsWith(prefix)) return -1;
	let depth = 1;
	for (let i = prefix.length; i < p.length; i++) {
		if (p.charCodeAt(i) === 47 /* "/" */) depth++;
	}
	return depth;
}

/**
 * List one directory, following the cursor to the end. With `recursive` this is
 * the whole subtree down to `depth` (default and maximum {@link MAX_DEPTH}),
 * excluding the root itself.
 */
export function* readdirPagesPlan(
	root: string,
	opts: PagesOptions = {}
): Plan<ReaddirPage> {
	let syscall = opts.syscall ?? "scandir";
	let maxEntries = opts.maxEntries ?? Infinity;
	let entries: FsEntry[] = [];
	let cursor: string | undefined;

	let first = true;

	do {
		let res = yield {
			url: readdirUrl(root, {
				recursive: opts.recursive,
				depth: opts.depth,
				cursor,
				// Ask the server to count the subtree on the first page whenever a
				// budget is in play, so an oversized listing is abandoned after one
				// page instead of after `maxEntries`-worth of them. Costs one
				// COUNT(*) and no extra round trip.
				includeTotal: first && maxEntries !== Infinity,
			}),
		};
		let body = res.json();
		if (!res.ok) {
			throw (
				translatePuterError(body?.code, syscall, root) ??
				new Error(body?.message ?? `failed to list ${root}`)
			);
		}

		let page = toPage(body);
		if (first && page.total !== undefined && page.total > maxEntries) {
			return { entries, complete: false };
		}
		first = false;

		for (let item of page.items) entries.push(normalizeFsEntry(item));
		cursor = page.cursor;

		if (entries.length >= maxEntries) return { entries, complete: false };
		// Only a null/absent cursor means "last page" — `items.length < limit`
		// does not, and treating it as such truncates listings at random.
	} while (cursor !== undefined && cursor !== null);

	return { entries, complete: true };
}

/**
 * Every descendant of `root`, at any depth.
 *
 * The api caps a single recursive call at {@link MAX_DEPTH} levels, so any
 * directory returned at exactly that depth becomes a new root and is walked
 * again. No de-duplication is needed: a call rooted at `r` excludes `r` itself,
 * so a follow-up rooted at a horizon directory returns a disjoint set.
 *
 * Entries come back ordered by full path, ascending — the api's ordering, not
 * the DFS order this used to produce. node guarantees no particular order.
 */
export function* readdirTreePlan(root: string): Plan<FsEntry[]> {
	let out: FsEntry[] = [];
	let frontier: string[];

	if (root === "/") {
		// The api refuses a recursive listing at the root (400 bad_request — it
		// would be a prefix scan over every user). Enumerate it flat instead and
		// treat each top-level directory as its own recursive root.
		let page = yield* readdirPagesPlan("/", { recursive: false });
		out.push(...page.entries);
		frontier = page.entries.filter((e) => e.isDir).map((e) => e.path);
	} else {
		frontier = [root];
	}

	while (frontier.length > 0) {
		let current = frontier.shift()!;
		let page = yield* readdirPagesPlan(current, { recursive: true });
		out.push(...page.entries);

		for (let entry of page.entries) {
			if (entry.isDir && relDepth(current, entry.path) === MAX_DEPTH) {
				frontier.push(entry.path);
			}
		}
	}

	return out;
}
