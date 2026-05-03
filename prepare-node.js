import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const config = packageJson.nodeCore;
const checkoutDir = path.resolve(rootDir, config.checkoutDir);
const patchesDir = path.join(rootDir, 'patches');
const commit = config.commit;

function run(command, args, cwd = rootDir) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(' ')}`);
	}
}

if (!fs.existsSync(checkoutDir)) {
	fs.mkdirSync(path.dirname(checkoutDir), { recursive: true });
	run('git', ['clone', config.repository, checkoutDir, "--depth=1"]);
}

run('git', ['rev-parse', '--verify', commit], checkoutDir);

const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
	cwd: checkoutDir,
	encoding: 'utf8',
});

if (headResult.status !== 0 || headResult.stdout.trim() !== commit) {
	run('git', ['checkout', '--detach', commit], checkoutDir);
}

if (fs.existsSync(patchesDir)) {
	const patches = fs.readdirSync(patchesDir)
		.filter((file) => file.endsWith('.patch'))
		.sort();

	for (const patch of patches) {
		const patchPath = path.join(patchesDir, patch);
		const forward = spawnSync('git', ['apply', '--check', patchPath], { cwd: checkoutDir });
		if (forward.status === 0) {
			run('git', ['apply', patchPath], checkoutDir);
			continue;
		}

		const reverse = spawnSync('git', ['apply', '--reverse', '--check', patchPath], { cwd: checkoutDir });
		if (reverse.status !== 0) {
			throw new Error(`Patch does not apply cleanly: ${patch}`);
		}
	}
}
