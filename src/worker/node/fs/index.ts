import { depromisify } from "../utils";
import { fsConstants } from "./util";
import { Stats, StatsFs, Dirent, Dir } from "./classes";
import { promisesToDepromisify as promises1 } from "./promises";
import { promisesRemaining as promises2 } from "./promises-sync";
import { fsSync } from "./sync";
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
		for await (const entry of new Glob(pattern, options).glob()) out.push(entry);
		return out;
	})().then(
		(res) => callback(null, res),
		(err) => callback(err)
	);
}

// Each class is typed in `./classes.ts` as `Pick<NodeFs[X], keyof NodeFs[X]>
// & { new(puterShapedArgs): any }` so static members and instance shape are
// pinned to node, but our internal puter-shaped construction is allowed.
// `Pick<X, keyof X>` doesn't carry over the private construct signature node
// uses on these classes, so the `as any` here is the irreducible bit — TS
// treats private constructors nominally and we can't reproduce the brand.
export default {
	Dir: Dir as any,
	Dirent: Dirent as any,
	Stats: Stats as any,
	StatsFs: StatsFs as any,
	constants: fsConstants,
	promises,
	glob,
	...fsSync,
	...depromisify(promises1),
} satisfies typeof import("node:fs");
