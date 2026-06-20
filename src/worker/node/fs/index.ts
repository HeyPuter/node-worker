import { depromisify } from "../utils";
import { fsConstants } from "./util";
import { Stats, StatsFs, Dirent, Dir } from "./classes";
import { promisesToDepromisify as promises1 } from "./promises";
import { promisesRemaining as promises2 } from "./promises-sync";
import { fsSync } from "./sync";
import { fdOps } from "./fd";
// @ts-ignore — upstream node JS, glob spec impl backed by minimatch
import { Glob } from "node-core:internal/fs/glob";

let promises: typeof promises1 & typeof promises2 = Object.assign(
	{},
	promises1,
	promises2
);

// Callback-style fs.glob: drains the upstream async iterator and hands the
// array to the callback. Mirrors `node_core/lib/fs.js`'s `glob`.
function glob(pattern: any, options: any, callback?: any) {
	if (typeof options === "function") {
		callback = options;
		options = undefined;
	}
	(async () => {
		const out: any[] = [];
		for await (const entry of new Glob(pattern, options).glob())
			out.push(entry);
		return out;
	})().then(
		(res) => callback(null, res),
		(err) => callback(err)
	);
}

// Deprecated callback `fs.exists`: its callback takes a lone boolean (not the
// error-first shape depromisify produces), so it's written out by hand.
function exists(path: any, callback: (exists: boolean) => void) {
	try {
		callback(fsSync.existsSync(path));
	} catch {
		callback(false);
	}
}
// node exposes util.promisify(fs.exists) via this hook (resolves a boolean).
(exists as any).__promisify__ = (path: any) =>
	new Promise<boolean>((resolve) => exists(path, resolve));

// Each class is typed in `./classes.ts` as `Pick<NodeFs[X], keyof NodeFs[X]>
// & { new(puterShapedArgs): any }` so static members and instance shape are
// pinned to node, but our internal puter-shaped construction is allowed.
// `Pick<X, keyof X>` doesn't carry over the private construct signature node
// uses on these classes, so the `as any` here is the irreducible bit — TS
// treats private constructors nominally and we can't reproduce the brand.
let fs = {
	Dir: Dir as any,
	Dirent: Dirent as any,
	Stats: Stats as any,
	StatsFs: StatsFs as any,
	constants: fsConstants,
	promises,
	glob,
	...fsSync,
	...depromisify(promises1),
	// fd family overrides depromisify's `open` (which resolves a FileHandle) with
	// the callback contract that yields a numeric fd, and adds read/write/etc.
	...fdOps,
	// `fs.exists`'s callback takes a lone boolean, not depromisify's error-first
	// shape, so define it after the spreads.
	exists: exists as any,
} satisfies typeof import("node:fs");

// `realpath`/`realpathSync` carry a `.native` variant; ours is the same impl.
(fs.realpathSync as any).native = fs.realpathSync;
(fs.realpath as any).native = fs.realpath;
(promises.realpath as any).native = promises.realpath;

export default fs;
