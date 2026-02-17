import { runCode } from ".";
import fs from "./fs";
import internalModules from "./node";
import { sync as resolveSync, SyncOpts } from "resolve";
import { CWD } from "./state";

let resolveOpts: SyncOpts = {
	includeCoreModules: false,
	extensions: [".js"],
	readFileSync(file) {
	    return fs.readFileSync(file);
	},
    isFile: function isFile(file) {
        try {
            var stat = fs.statSync(file);
        } catch (e) {
            if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
            throw e;
        }
        return stat.isFile() || stat.isFIFO();
    },
    isDirectory: function isDirectory(dir) {
        try {
            var stat = fs.statSync(dir);
        } catch (e) {
            if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
            throw e;
        }
        return stat.isDirectory();
    },
	realpathSync(file) {
		// TODO
	    return file;
	},
};

let PREAMBLE = `
let module = { exports: {} };


`;
let AFTERWORD = `


return module.exports;
`;

export function require(target: string): any {
	if (target.startsWith("node:")) {
		target = target.slice("node:".length);
		if (Object.hasOwn(internalModules, target)) {
			return (internalModules as any)[target];
		}
		throw new Error(`Unknown internal module "node:${target}"`);
	}

	if (Object.hasOwn(internalModules, target)) {
		return (internalModules as any)[target];
	}

	if (resolveSync(target, { ...resolveOpts, basedir: CWD })) {
		try {
			let source = fs.readFileSync(target, "utf-8");

			return runCode(source, false, [PREAMBLE, AFTERWORD]);
		} catch(e) {
			throw new Error(`Failed to load module from "${target}"`, { cause: e })
		}
	}

	throw new Error(`Unknown target ${target}`);
}
