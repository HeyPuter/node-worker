import { depromisify } from "../node";
import { fsConstants } from "./util";
import { Stats, StatsFs, Dirent, Dir } from "./classes";
import { promisesToDepromisify as promises1, promisesRemaining as promises2 } from "./promises";
import { fsSync } from "./sync";

let promises: typeof promises1 & typeof promises2 = Object.assign({}, promises1, promises2);

export default {
	Dir: Dir as any,
	Dirent: Dirent as any,
	Stats: Stats as any,
	StatsFs: StatsFs as any,
	constants: fsConstants,
	promises,
	...fsSync,
	...depromisify(promises1),
} satisfies typeof import("node:fs");
