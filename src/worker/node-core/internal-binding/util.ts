// `internalBinding('util')` — only the surface upstream node-core JS actually
// calls. `isInsideNodeModules(depth)` walks the call stack looking for a
// node_modules frame; in this runtime there's no such notion, so it always
// returns false and lets the caller treat the call as user code.

export default {
	isInsideNodeModules(_depth: number): boolean {
		return false;
	},
};
