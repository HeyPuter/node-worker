// What a filesystem backend has to implement.
//
// A provider is the layer that actually knows how to reach some storage:
// puterfs over HTTP, an in-memory tree, a zip's central directory. Everything
// above it — argument coercion, node's classes, node's overload sets — belongs to
// the fs surface, and everything about *which* provider serves a path belongs to
// the mount table. A provider sees an absolute, already-normalized, mount-local
// path and a `Buffer`, and nothing else.
//
// Two rules hold for every implementation, neither of them expressible in the
// type system, and both worth grepping for in review:
//
//   1. **Providers are pure with respect to the mount table.** A provider never
//      calls `resolveMount()` and never reaches for the table to answer a
//      question about a path it was handed. Layering is composed from outside
//      instead — `unionProvider(upper, lower)` receives its layers as arguments.
//      Without this rule the facade and the providers import each other, which
//      is precisely the shape of the `internal-binding/index.ts` cycle, and it
//      fails the same way: whichever side happens to evaluate first shifts with
//      any unrelated change.
//   2. **No provider method may call `runSync`.** Every method is a `Plan`, so it
//      already works under both drivers; calling the blocking driver from inside
//      one would freeze the worker in the middle of an operation the caller
//      believes is asynchronous. The tempting place to get this wrong is lazy
//      initialization — a zip provider loading its central directory on first
//      use — and it stays invisible until a large file shows up.
//
// This module is types only, for the same reason ../plan.ts is: the fs subgraph
// evaluates inside a module-init cycle (see ../lazy-base.ts) and anything
// imported this widely must be safe to evaluate first.

import type { Plan } from "../plan";
import type { FsEntry } from "../util";

/**
 * Per-operation context. Threaded explicitly rather than reconstructed by a
 * `catch` upstream, because `translatePuterError` bakes the syscall and path into
 * the *message string* — so decorating an error after the fact would mean
 * re-rendering it.
 */
export interface OpCtx {
	/** node's syscall name, for `err.syscall` and the message: "stat", "scandir", "open", "unlink", … */
	readonly syscall: string;
	/**
	 * The path as the caller spelled it, which is not the path the provider is
	 * working on. A zip mounted at `/p/node_modules` that fails on its local
	 * `/lodash/index.js` has to report `'/p/node_modules/lodash/index.js'`, or the
	 * error names a path that does not exist from the caller's point of view.
	 */
	readonly reportPath: string;
	/** Reserved for the cache layer. Declared now so adding it later is not a signature change. */
	readonly cache?: "default" | "reload" | "only-if-cached";
}

export interface ReaddirOpts {
	recursive?: boolean;
	depth?: number;
	/** Stop once this many entries have accumulated. */
	maxEntries?: number;
}

export interface Listing {
	entries: FsEntry[];
	/**
	 * Whether the listing is *exhaustive*. A walk cut short by `maxEntries` is a
	 * valid prefix but not a complete picture, and the difference is load-bearing:
	 * "this directory contains nothing else" is what lets a later miss under it be
	 * answered as ENOENT without a round trip. Anything deriving a negative from a
	 * listing must check this first.
	 */
	complete: boolean;
}

/**
 * A pull-based byte source, for `createReadStream`.
 *
 * Streaming sits *outside* the plan protocol on purpose: a plan step's result is
 * a response that has already completed, which is the one thing a stream is not.
 * So this is async-only and optional — a provider that doesn't implement it gets
 * one synthesized from `readFile`, and `ReadStream` never has to branch on
 * whether a given backend can stream.
 *
 * It is a pull interface rather than "hand back a Buffer" so that a zip entry can
 * be inflated incrementally instead of all at once.
 */
export interface ByteSource {
	/** Resolves null at EOF. May return fewer or more bytes than `hint`. */
	read(hint: number): Promise<Buffer | null>;
	/** Idempotent. Must release any transport resource, including the keepalive ref. */
	close(): void | Promise<void>;
	/** Total length, when the source knows it without reading. */
	readonly size?: number;
}

export interface FsProvider {
	/** For diagnostics and cache keying. */
	readonly name: string;

	// --- primitives: every provider implements these ---

	/** Throws a node-shaped ENOENT (or ENOTDIR) when the path isn't there. */
	stat(ctx: OpCtx, path: string): Plan<FsEntry>;
	readdir(ctx: OpCtx, path: string, opts?: ReaddirOpts): Plan<Listing>;
	readFile(ctx: OpCtx, path: string): Plan<Buffer>;
	writeFile(ctx: OpCtx, path: string, data: Buffer): Plan<void>;
	mkdir(
		ctx: OpCtx,
		path: string,
		opts: { recursive: boolean }
	): Plan<string | undefined>;
	rm(
		ctx: OpCtx,
		path: string,
		opts: { recursive: boolean; force: boolean }
	): Plan<void>;
	rename(ctx: OpCtx, from: string, to: string): Plan<void>;
	/**
	 * Set access and modification times, in epoch milliseconds.
	 *
	 * Returns whether anything was actually applied. `false` is a normal answer, not
	 * an error, because a backend may not be able to represent the request at all:
	 * puterfs can only set a timestamp to *now* (`POST /touch` has no field for a
	 * value), so anything else is a no-op there. A caller that gets `false` still
	 * owes the user an ENOENT for a missing path, so it has to validate some other
	 * way — see ../times.ts.
	 *
	 * The decision about what is representable belongs to the provider, since it is
	 * a fact about the backend. An in-memory tree simply sets both exactly.
	 */
	utimes(ctx: OpCtx, path: string, atimeMs: number, mtimeMs: number): Plan<boolean>;

	// --- optional fast paths: the layer derives these when absent ---

	/**
	 * Server-side copy. puterfs has `/copy`, which is one round trip and never
	 * moves the bytes through the worker; deriving it from read+write would move
	 * the whole file twice. Absent on memory and zip, where the derived form costs
	 * nothing.
	 */
	copyFile?(
		ctx: OpCtx,
		from: string,
		to: string,
		opts: { overwrite: boolean }
	): Plan<void>;
	/**
	 * Positioned read. On puterfs this is a `Range` header, which makes the GET
	 * non-simple and therefore costs a CORS preflight; on memory and zip it is a
	 * `subarray`. Absent ⇒ the layer serves it by slicing a whole-file read.
	 */
	readRange?(
		ctx: OpCtx,
		path: string,
		offset: number,
		length: number
	): Plan<Buffer>;
	statfs?(ctx: OpCtx): Plan<{ used: number; capacity: number }>;
	openRead?(
		ctx: OpCtx,
		path: string,
		range?: { start: number; end?: number }
	): Promise<ByteSource>;
	/**
	 * An opaque token identifying the *file* rather than the path, captured when a
	 * handle opens so the handle keeps referring to the same file if the path is
	 * later rewritten, moved, or unlinked — the role an inode plays on a real
	 * filesystem.
	 *
	 * puterfs returns undefined: it exposes no inode, so path-based is all that is
	 * available there (which is what the current implementation already does).
	 */
	pin?(ctx: OpCtx, path: string): Plan<unknown>;
}
