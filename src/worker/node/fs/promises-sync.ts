// @ts-ignore — upstream node JS, glob spec impl backed by minimatch
import { Glob } from "node-core:internal/fs/glob";
import { fsConstants } from "./util";

type NodeFs = typeof import("node:fs");
type NodeFsPromises = NodeFs["promises"];

export let promisesRemaining: Pick<
	NodeFsPromises,
	"watch" | "glob" | "constants"
> = {
	constants: { ...fsConstants },
	glob(pattern, options?) {
		return new Glob(pattern, options).glob();
	},
};
