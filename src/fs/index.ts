import { depromisify } from "../node";
import { fsConstants } from "./util";
import { Stats, StatsFs, Dirent, Dir } from "./classes";
import { promisesToDepromisify, promises } from "./promises";
import { fsSync } from "./sync";

export default {
	Dir: Dir as any,
	Dirent: Dirent as any,
	Stats: Stats as any,
	StatsFs: StatsFs as any,
	constants: fsConstants,
	promises,
	...fsSync,
	...depromisify(promisesToDepromisify),
} satisfies typeof import("node:fs");
