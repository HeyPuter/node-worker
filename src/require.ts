import internalModules from "./node";

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

	throw new Error(`Unknown target ${target}`);
}
