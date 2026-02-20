import internalModules from "../node";
import { createRequire } from "./require";

export interface CJSModule {
	children: CJSModule[];
	exports: any;
	filename: string;
	id: string;
	isPreloading: false;
	loaded: boolean;
	path: string;
	paths: string[];
	require: (id: string) => any;
}

let CJS_HARNESS = (code: string, module: CJSModule) => new Function(
	"internalModules", "module",
	`
		(({ process, buffer: { Buffer } }, require, module, exports, __dirname, __filename) => {
			${code}
		})(internalModules, module.require, module, module.exports, module.path, module.filename)
	`
).bind(null, internalModules, module);

export function createCjsModule(code: string, filePath: string): [CJSModule, () => void] {
	let dirname = internalModules.path.dirname(filePath);
	let module: CJSModule = {
		children: [], // TODO handle children
		exports: {},
		filename: filePath,
		id: filePath,
		isPreloading: false,
		loaded: false,
		path: dirname,
		paths: [], // TODO handle paths
		require: createRequire(dirname)
	};
	let harness = CJS_HARNESS(code, module);
	return [
		module,
		() => {
			harness();
			module.loaded = true;
		}
	]
}
