// The host-side filesystem a `NodeWorker` runs on.
//
// One of these per worker by default. Every worker has had its own `/tmp`, its own overlay
// and its own memory mounts for as long as those have existed, and a single shared namespace
// would silently start sharing all three — wrong for injected modules, and wrong for a
// consumer that populates a project per worker and treats each as a private replica. Pass an
// explicit instance to opt into sharing.
//
// What used to be eight page↔worker message types (`mem-mount`, `mem-write`, `mem-read`,
// `mem-list`, `mem-remove`, `mem-unmount`, `vmodule-add`, `vmodule-remove`) is now ordinary
// method calls on this object, and **synchronous**: there is no boundary left to cross. That
// also retires `writeMemory`'s `{transfer: true}` hazard, where populating a mount detached
// every buffer you passed.

import { resolveFrom } from "../../vfs/path";
import type { MountSnapshot } from "../../vfs/wire";
import type { FsEntry, Listing, ReaddirOpts } from "../../vfs/entry";
import { NODEFS_PROTO } from "../../vfs/wire";
import type { ProviderStream, VfsProvider } from "../../vfs/provider";
import type { PuterFsEvent } from "../../protocol";
import { createFsEvents, type FsEvents } from "./events";
import { Facade } from "./facade";
import { MountTable } from "./mounts";
import { createReplayCache, handleFrame, type DispatchDeps } from "./dispatch";
import { HandleRegistry } from "./handles";
import {
	createMemoryProvider,
	type MemListEntry,
	type MemListOptions,
	type MemoryProvider,
} from "./memory";
import { createPuterProvider } from "./puter";
import { PuterApi } from "./puter-http";
import { unionProvider } from "./union";

const encoder = new TextEncoder();

export interface NodeVfsOptions {
	/**
	 * Mount puterfs at "/" with a sparse in-memory overlay above it, which is what the
	 * runtime has always started with. Omit for a namespace with no network backend at all —
	 * useful for a worker that only ever sees memory or OPFS mounts.
	 */
	puter?: { token: string; apiOrigin?: string };
	/** Mount a memory-backed `/tmp`. Default true. */
	tmp?: boolean;
	/** Identifies this session on the wire. Generated when absent. */
	sid?: string;
}

/**
 * What a provider factory is handed at mount time.
 *
 * Shaped to be spread straight into a provider's options — `createDirectoryHandleProvider(h, m)` —
 * so the two things a provider cannot work out for itself arrive together and cannot disagree.
 */
export interface MountContext {
	/** Where synthesized watch events go, so `fs.watch` sees this mount's mutations. */
	events: FsEvents;
	/** The absolute path this provider is mounted at, for reporting those events. */
	prefix: string;
}

/** One entry to place into a memory mount. */
export interface MemEntry {
	/**
	 * Relative to the mount root; a leading "/" is accepted and ignored. Absent `data`
	 * creates a directory — files create their own parents, so that is only needed for a
	 * deliberately empty one.
	 */
	path: string;
	data?: string | Uint8Array | ArrayBuffer;
	mtimeMs?: number;
}

/**
 * A memory mount, from the host's side. Every method is synchronous.
 */
export interface MemoryMount {
	readonly root: string;
	write(entries: MemEntry[]): { written: number; bytes: number };
	/** The file's bytes, or undefined if the path is absent or a directory. */
	read(path: string): Uint8Array | undefined;
	/**
	 * Walk a directory, or undefined if the path is absent or a file.
	 *
	 * `since` reports only what was modified after that time, which is what makes "what did
	 * this run touch?" cheap even over a tree with a `node_modules` in it. The walk is
	 * complete regardless — a directory's mtime says nothing about its descendants — so the
	 * saving is in the answer, not the search.
	 */
	list(path: string, opts?: MemListOptions): MemListEntry[] | undefined;
	remove(paths: string[]): void;
	mkdir(path: string): void;
}

export class NodeVfs {
	readonly sid: string;
	#table = new MountTable();
	#facade: Facade;
	#handles: HandleRegistry;
	#api: PuterApi | undefined;
	#events: FsEvents;

	/** The sparse in-memory layer over the root mount. Also where injected files land. */
	#overlay: MemoryProvider;
	/** Per-mount injection overlays, from `mount(..., { overlay: true })`. */
	#overlays = new Map<string, MemoryProvider>();
	#tmp: MemoryProvider | undefined;
	/** Memory mounts the host created, by root. */
	#memoryMounts = new Map<string, MemoryProvider>();

	/** Queued for the reply of the call that caused them. */
	#replies = createReplayCache();
	/**
	 * How deep inside `handleFrame` we are, which is what tells a worker-caused mutation from a
	 * host-caused one. A counter rather than a flag because two frames can be in flight at once —
	 * the asynchronous transport does not wait for one call before accepting the next.
	 */
	#dispatchDepth = 0;
	#pendingEvents: PuterFsEvent[] = [];
	#pendingPaths = new Set<string>();
	#pendingSubtrees = new Set<string>();
	#listeners = new Set<
		(event: PuterFsEvent, causedBy: string | undefined) => void
	>();
	#mountListeners = new Set<(snapshot: MountSnapshot[]) => void>();

	constructor(opts: NodeVfsOptions = {}) {
		this.sid = opts.sid ?? randomSid();
		this.#facade = new Facade(this.#table);
		this.#handles = new HandleRegistry(this.#facade);
		this.#events = createFsEvents((event) => this.#emit(event));

		this.#table.onChange(() => {
			const snapshot = this.#table.snapshot();
			for (const fn of [...this.#mountListeners]) fn(snapshot);
		});

		// Mounted at "/", so a local path already is the absolute one.
		this.#overlay = createMemoryProvider({
			name: "overlay",
			prefix: "",
			events: this.#events,
		});

		if (opts.puter) {
			this.#api = new PuterApi(opts.puter.token, opts.puter.apiOrigin);
			const puter = createPuterProvider({
				api: this.#api,
				events: this.#events,
			});
			// `"existing"` rather than `"upper"`: a write to a path the overlay holds updates
			// the overlay, but a write to an ordinary path still goes to ordinary storage.
			// Routing every write into memory would silently stop persisting anything.
			this.#table.mount("/", unionProvider(this.#overlay, puter, "existing"));
		} else {
			this.#table.mount("/", this.#overlay);
		}

		if (opts.tmp !== false) {
			// `os.tmpdir()` has always returned "/tmp", but puterfs has no such directory and
			// cannot grow one: the root holds user home directories and writing to it is
			// refused, so `mkdir("/tmp")` fails and every `mkdtemp`-style caller was pointed
			// at an unusable path. An in-memory mount is what that path should have been —
			// scratch space that is fast, private, and gone when the worker is.
			this.#tmp = createMemoryProvider({
				name: "tmp",
				prefix: "/tmp",
				events: this.#events,
			});
			this.#table.mount("/tmp", this.#tmp);
		}
	}

	// -------------------------------------------------------------- the mount table

	/**
	 * Mount a provider at `root`.
	 *
	 * Takes a **factory** as well as a provider, and that is not sugar: a provider needs the
	 * session's watch-event sink and its own mount prefix in order to report `fs.watch` events,
	 * and a caller who constructed it themselves has neither. Passing a factory lets this supply
	 * both, correctly — where handing out the sink and asking the caller to also pass a matching
	 * prefix would silently produce events with the wrong paths whenever the two disagreed.
	 *
	 *   vfs.mount("/opfs", (m) => createDirectoryHandleProvider(handle, m));
	 *
	 * `overlay` puts a sparse in-memory layer in front of the provider — the same arrangement `/`
	 * has over puterfs. It exists for `addVirtualFile`/`registerVirtualModule`, which need
	 * *somewhere* to put a module that has no business being written to the backend: a run's entry
	 * point has to sit inside the project to resolve the project's `node_modules`, and persisting
	 * it there would leave litter behind on every run. Writes to paths the overlay does not hold
	 * still go to the provider, so an ordinary file write is unaffected.
	 */
	mount(
		root: string,
		provider: VfsProvider | ((mount: MountContext) => VfsProvider),
		opts?: { readOnly?: boolean; overlay?: boolean }
	): void {
		const normalized = normalizeRoot(root);
		const built =
			typeof provider === "function"
				? provider({ events: this.#events, prefix: normalized })
				: provider;
		let mounted = built;
		if (opts?.overlay) {
			const overlay = createMemoryProvider({
				name: `overlay:${normalized}`,
				prefix: normalized,
				events: this.#events,
			});
			this.#overlays.set(normalized, overlay);
			// "existing" and not "upper": a write goes to whichever layer already holds the path,
			// so only what was injected here stays here and everything else reaches the backend.
			mounted = unionProvider(overlay, built, "existing");
		}
		this.#table.mount(normalized, mounted, opts);
		// Anything the worker's resolver concluded about this subtree — including "there is
		// nothing here", which it derives from a fully-listed ancestor — predates the mount
		// and is now wrong.
		this.#pendingSubtrees.add(normalized);
	}

	unmount(root: string): boolean {
		const normalized = normalizeRoot(root);
		const removed = this.#table.unmount(normalized);
		if (removed) this.#pendingSubtrees.add(normalized);
		this.#memoryMounts.delete(normalized);
		this.#overlays.delete(normalized);
		return removed;
	}

	listMounts(): readonly MountSnapshot[] {
		return this.#table.snapshot();
	}

	snapshot(): MountSnapshot[] {
		return this.#table.snapshot();
	}

	onMountsChanged(fn: (snapshot: MountSnapshot[]) => void): () => void {
		this.#mountListeners.add(fn);
		return () => this.#mountListeners.delete(fn);
	}

	// ------------------------------------------------------------- memory mounts

	/**
	 * Create a memory-backed directory at `root`.
	 *
	 * `replace` swaps out an existing mount at the same root instead of throwing, which is
	 * what re-populating a project between runs wants.
	 */
	mountMemory(
		root: string,
		opts: { readOnly?: boolean; replace?: boolean } = {}
	): MemoryMount {
		const normalized = normalizeRoot(root);
		if (normalized === "/") {
			throw new Error("/ is already mounted; write to it directly instead");
		}
		if (this.#memoryMounts.has(normalized)) {
			if (!opts.replace) throw new Error(`already mounted: ${normalized}`);
			this.unmountMemory(normalized);
		}
		const provider = createMemoryProvider({
			name: `host:${normalized}`,
			prefix: normalized,
			events: this.#events,
		});
		this.#table.mount(normalized, provider, { readOnly: opts.readOnly });
		this.#memoryMounts.set(normalized, provider);
		this.#pendingSubtrees.add(normalized);
		return this.#wrap(normalized, provider);
	}

	unmountMemory(root: string): void {
		const normalized = normalizeRoot(root);
		if (!this.#memoryMounts.delete(normalized)) return;
		this.#table.unmount(normalized);
		this.#pendingSubtrees.add(normalized);
	}

	/** "/" is the sparse overlay over the root mount, rather than a mount of its own. */
	memory(root = "/"): MemoryMount {
		const normalized = normalizeRoot(root);
		if (normalized === "/") return this.#wrap("/", this.#overlay);
		const provider = this.#memoryMounts.get(normalized);
		if (!provider) throw new Error(`no memory mount at ${normalized}`);
		return this.#wrap(normalized, provider);
	}

	#wrap(base: string, provider: MemoryProvider): MemoryMount {
		const abs = (local: string) => (base === "/" ? local : base + local);
		return {
			root: base,
			write: (entries) => {
				let bytes = 0;
				for (const entry of entries) {
					// Entry paths are relative to the mount root. Resolving against "/" rather
					// than against `base` keeps a `..` in a hostile or careless path from
					// climbing out of the mount — it can only ever bottom out at the root.
					const local = resolveFrom("/", entry.path);
					const existed = provider.get(local) !== undefined;

					if (entry.data === undefined) {
						provider.mkdirp(local);
						if (!existed) this.#events.add(abs(local), true);
						continue;
					}
					const data = toBytes(entry.data);
					const file = provider.put(local, data);
					if (entry.mtimeMs !== undefined) file.mtimeMs = entry.mtimeMs;
					bytes += data.length;

					// Watch events, because these writes go straight to the provider and so
					// bypass the facade that would otherwise emit them. Without this a host
					// edit is invisible to `fs.watch` inside the runtime — which is to say a
					// dev server never notices the file changed, and HMR never fires.
					if (existed) this.#events.write(abs(local));
					else this.#events.add(abs(local));
					this.#pendingPaths.add(abs(local));
				}
				return { written: entries.length, bytes };
			},
			read: (path) => {
				const live = provider.get(resolveFrom("/", path));
				if (!live) return undefined;
				// A copy: the caller may keep or mutate it, and the tree owns its bytes.
				return new Uint8Array(live);
			},
			list: (path, opts) => provider.list(resolveFrom("/", path), opts),
			remove: (paths) => {
				for (const path of paths) {
					const local = resolveFrom("/", path);
					// Directory-ness has to be read before the drop, and only matters to the
					// watcher.
					const wasDir = provider.list(local) !== undefined;
					if (provider.drop(local)) this.#events.remove(abs(local), wasDir);
					this.#pendingPaths.add(abs(local));
				}
			},
			mkdir: (path) => {
				const local = resolveFrom("/", path);
				provider.mkdirp(local);
				this.#events.add(abs(local), true);
				this.#pendingPaths.add(abs(local));
			},
		};
	}

	// ---------------------------------------------------------- injected modules

	/**
	 * The in-memory layer that actually serves `path`, and the path within it.
	 *
	 * Not always the root overlay. Once a mount exists at, say, `/proj`, longest prefix wins and
	 * every read under it resolves to *that* mount — so putting the file in the root overlay would
	 * leave it permanently unreachable, shadowed by the very mount it appears to live in. So the
	 * layer has to belong to the owning mount: either a memory mount, or the overlay a mount was
	 * given by `mount(..., { overlay: true })`.
	 */
	#injectionTarget(path: string): { provider: MemoryProvider; local: string } {
		const { mount: owner, local } = this.#table.resolve(path);
		if (owner.root === "/") return { provider: this.#overlay, local: path };
		const provider =
			this.#memoryMounts.get(owner.root) ?? this.#overlays.get(owner.root);
		if (!provider) {
			// Some other kind of backend owns this subtree — an OPFS directory, say. There is no
			// in-memory layer to put the file in, and silently writing it somewhere unreachable
			// would be worse than saying so. The fix is named because the error is otherwise a
			// dead end: nothing about "non-memory mount" suggests that a mount can be given a
			// memory layer without becoming one.
			throw new Error(
				`cannot inject at ${path}: ${owner.root} is served by a non-memory mount. ` +
					`Mount it with { overlay: true } to give it an in-memory layer for ` +
					`injected files.`
			);
		}
		return { provider, local };
	}

	addVirtualFile(path: string, code: string | Uint8Array): void {
		const resolved = resolveFrom("/", path);
		const { provider, local } = this.#injectionTarget(resolved);
		provider.put(local, toBytes(code));
		// The worker's resolver caches source text and stat results permanently. Injected
		// files are the one thing that can be replaced at a stable path, so the caches have
		// to be told — this is the invalidation that used to be a direct function call from
		// the worker's own `virtual.ts`, and dropping it would mean a second run compiling
		// the first run's source.
		this.#pendingPaths.add(resolved);
	}

	removeVirtualFile(path: string): void {
		const resolved = resolveFrom("/", path);
		const { provider, local } = this.#injectionTarget(resolved);
		provider.drop(local);
		this.#pendingPaths.add(resolved);
	}

	// --------------------------------------------------- the filesystem, from here
	//
	// The host's own way in, and it is not a convenience: a write made *behind* the filesystem —
	// straight to OPFS, say — is invisible to it, so no watch event is emitted and anything
	// watching inside the runtime never learns the file changed. That is exactly how an editor
	// save stops triggering HMR. Going through the facade means a host write is an ordinary
	// filesystem write: the provider runs, the event fires, and watchers see it.
	//
	// Async, because that is what a provider is. The synchronous `memory()` API stays for memory
	// mounts, where there is nothing to await.

	async stat(path: string): Promise<FsEntry> {
		const p = resolveFrom("/", path);
		return this.#facade.stat({ syscall: "stat", reportPath: p }, p);
	}

	async readFile(path: string): Promise<Uint8Array> {
		const p = resolveFrom("/", path);
		return this.#facade.readFile({ syscall: "open", reportPath: p }, p);
	}

	async writeFile(path: string, data: Uint8Array | string): Promise<void> {
		const p = resolveFrom("/", path);
		await this.#facade.writeFile(
			{ syscall: "write", reportPath: p },
			p,
			toBytes(data)
		);
	}

	async readdir(path: string, opts?: ReaddirOpts): Promise<Listing> {
		const p = resolveFrom("/", path);
		return this.#facade.readdir({ syscall: "scandir", reportPath: p }, p, opts);
	}

	async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
		const p = resolveFrom("/", path);
		await this.#facade.mkdir({ syscall: "mkdir", reportPath: p }, p, {
			recursive: !!opts.recursive,
		});
	}

	async rm(
		path: string,
		opts: { recursive?: boolean; force?: boolean } = {}
	): Promise<void> {
		const p = resolveFrom("/", path);
		await this.#facade.rm({ syscall: "unlink", reportPath: p }, p, {
			recursive: !!opts.recursive,
			force: !!opts.force,
		});
	}

	// ------------------------------------------------------------------ events

	/**
	 * Mutations this filesystem performs, with the session that caused them.
	 *
	 * Fires for every mutation this filesystem performs, whoever caused it — which is what a
	 * consumer keeping a read model in step with the runtime needs.
	 *
	 * `causedBy` is the session id when a worker call caused it, and `undefined` when the host did.
	 * The distinction matters for one thing only: a worker-caused mutation has already reached that
	 * worker on the reply frame, so anything forwarding events *into* workers is choosing between
	 * a duplicate and a drop. See `#emit` for why this one picks the duplicate.
	 */
	onFsEvent(
		fn: (event: PuterFsEvent, causedBy: string | undefined) => void
	): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/**
	 * Two deliveries, deliberately overlapping.
	 *
	 * A mutation made **during a worker call** rides that call's reply. That is the only delivery
	 * that reaches a worker parked inside a blocking request, and the only one that works for a
	 * consumer with no token and therefore no events channel at all.
	 *
	 * Every mutation is *also* announced to listeners. That is the path a mutation made **outside**
	 * a call has to take — a host write, an editor save — because there is no reply for it to ride
	 * and the worker may be sitting in a watcher making no calls whatsoever. Missing this is
	 * silent and oddly specific: everything keeps working except that saving a file stops
	 * triggering HMR.
	 *
	 * So a worker can see one of its own writes twice, once per path. That is the cheap side of the
	 * trade — watch events are deliberately not deduplicated anyway (`worker/fsevents.ts`), and a
	 * repeated event costs a redundant rebuild where a dropped one costs a dev server that has
	 * quietly stopped noticing edits. `causedBy` is there for a listener that would rather filter.
	 */
	#emit(event: PuterFsEvent) {
		const causedBy = this.#dispatchDepth > 0 ? this.sid : undefined;
		if (causedBy !== undefined) this.#pendingEvents.push(event);
		for (const fn of [...this.#listeners]) {
			try {
				fn(event, causedBy);
			} catch (err) {
				console.warn("[node-worker] fs event listener threw", err);
			}
		}
	}

	// -------------------------------------------------------------------- stats

	/** Per-endpoint backend call counts, the host half of `NODE_WORKER_API_STATS`. */
	apiStats(): Record<string, number> {
		return this.#api?.stats() ?? {};
	}

	/** Filesystem operations per mount — the count that only this side can see. */
	opStats(): Record<string, number> {
		return this.#facade.opStats();
	}

	resetStats() {
		this.#api?.resetStats();
		this.#facade.resetOpStats();
	}

	// ------------------------------------------------------------- the transport

	/** @internal — the one entry point both transports call. */
	async handleFrame(frame: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
		this.#dispatchDepth++;
		try {
			return await handleFrame(this.#deps(), frame);
		} finally {
			this.#dispatchDepth--;
		}
	}

	/**
	 * Drop this session's open files.
	 *
	 * Called when the worker goes away, and it has to be: a handle lives here now and outlives
	 * the worker that opened it, so without this every run leaks its open files — and for a
	 * memory mount that means leaking the contents of unlinked files, which stay alive on
	 * purpose for exactly as long as a handle refers to them.
	 *
	 * Dirty buffers are **not** flushed. A worker that died did not ask for its pending writes
	 * to land, and inventing a flush would publish half-written files nobody asked to publish.
	 */
	closeSession(): void {
		this.#handles.closeAll();
	}

	/** How many fds this session currently holds. Diagnostics. */
	get openHandles(): number {
		return this.#handles.size;
	}

	/** @internal — `createReadStream`, which is async-only and so sits outside the frames. */
	openRead(
		path: string,
		range?: { start: number; end?: number }
	): Promise<ProviderStream> {
		return this.#facade.openRead(
			{ syscall: "read", reportPath: path },
			resolveFrom("/", path),
			range
		);
	}

	/**
	 * @internal — a stream over an open fd, for `createReadStream({ fd })`.
	 *
	 * Separate from `openRead` because a handle may hold bytes the backend has not seen: those
	 * are the file as far as that fd is concerned, and streaming the backend's version instead
	 * would silently serve stale content.
	 */
	openReadFd(
		fd: number,
		range?: { start: number; end?: number }
	): Promise<ProviderStream> {
		return this.#handles.get(fd, "read").openRead(range);
	}

	#deps(): DispatchDeps {
		return {
			fs: this.#facade,
			table: this.#table,
			handles: this.#handles,
			replies: this.#replies,
			sid: this.sid,
			proto: NODEFS_PROTO,
			drainEvents: () => {
				const out = this.#pendingEvents;
				this.#pendingEvents = [];
				return out;
			},
			drainInvalidations: () => {
				if (this.#pendingPaths.size === 0 && this.#pendingSubtrees.size === 0) {
					return undefined;
				}
				const out = {
					paths: this.#pendingPaths.size ? [...this.#pendingPaths] : undefined,
					subtrees: this.#pendingSubtrees.size
						? [...this.#pendingSubtrees]
						: undefined,
				};
				this.#pendingPaths.clear();
				this.#pendingSubtrees.clear();
				return out;
			},
		};
	}
}

function randomSid(): string {
	return [...Array(10)].reduce((a) => a + Math.random().toString(36)[2], "");
}

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
	if (typeof data === "string") return encoder.encode(data);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	// A copy, because the tree must own its bytes rather than pin whatever the caller
	// happened to slice this view out of.
	return new Uint8Array(data);
}

/** Absolute, no trailing slash, no `.`/`..`/`//` — the form the mount table demands. */
function normalizeRoot(root: string): string {
	const resolved = resolveFrom("/", root);
	return resolved.length > 1 && resolved.endsWith("/")
		? resolved.slice(0, -1)
		: resolved;
}

// Re-exported so a consumer can build a namespace by hand — mount their own provider,
// layer one over another, or drive puterfs without a worker at all.
export { createMemoryProvider, type MemListEntry, type MemListOptions };
export { createPuterProvider, PuterApi };
export type { FsEvents } from "./events";
export {
	createDirectoryHandleProvider,
	ensureDirectoryHandleAccess,
	type DirectoryHandleProviderOptions,
} from "./handle-dir";
export { unionProvider, type WriteTarget } from "./union";
