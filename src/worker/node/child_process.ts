function unsupported(name: string) {
	return () => {
		throw new Error(
			`node:child_process.${name} is not supported in this runtime`
		);
	};
}

class ChildProcess {
	constructor() {
		throw new Error(
			"node:child_process.ChildProcess is not supported in this runtime"
		);
	}
}

const childProcess = {
	ChildProcess,
	exec: unsupported("exec"),
	execFile: unsupported("execFile"),
	execFileSync: unsupported("execFileSync"),
	execSync: unsupported("execSync"),
	fork: unsupported("fork"),
	spawn: unsupported("spawn"),
	spawnSync: unsupported("spawnSync"),
};

export default childProcess as unknown as typeof import("node:child_process");
