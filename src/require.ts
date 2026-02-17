import { runCode } from ".";
import fs from "./fs";
import internalModules from "./node";
import { sync as resolveSync, SyncOpts } from "resolve";
import { CWD } from "./state";
import path from "path";

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
	return requireWithBasedir(target, CWD);
}

function createRequire(basedir: string): (target: string) => any {
	return (target: string) => requireWithBasedir(target, basedir);
}

function requireWithBasedir(target: string, basedir: string): any {
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

	let resolvedTarget: string;
	try {
		resolvedTarget = resolveSync(target, { ...resolveOpts, basedir });
	} catch (e) {
		throw new Error(`Unknown target ${target}`, { cause: e });
	}

	try {
		let source = fs.readFileSync(resolvedTarget, "utf-8");
		let moduleRequire = createRequire(path.dirname(resolvedTarget));
		return runCode(source, false, [PREAMBLE, AFTERWORD], moduleRequire);
	} catch (e) {
		throw new Error(`Failed to load module from "${resolvedTarget}"`, {
			cause: e,
		});
	}
}
