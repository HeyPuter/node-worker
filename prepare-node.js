import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const nodeConfig = packageJson.nodeCore;

const EMSDK_CONFIG = {
	repository: 'https://github.com/emscripten-core/emsdk.git',
	commit: '3.1.56',
	checkoutDir: 'emsdk',
	toolVersion: '3.1.56',
};

const nodeCheckoutDir = path.resolve(rootDir, nodeConfig.checkoutDir);
const emsdkDir = path.resolve(rootDir, EMSDK_CONFIG.checkoutDir);
const llhttpWasmOutputFile = path.resolve(rootDir, 'generated/llhttp/llhttp.wasm');
const llhttpWasmModuleFile = path.resolve(rootDir, 'generated/llhttp/llhttp.wasm.js');
const llhttpShimFile = path.join(
	rootDir,
	'src',
	'worker',
	'node-core',
	'internal-binding',
	'http_parser',
	'llhttp-wasm-shim.c',
);
const patchesDir = path.join(rootDir, 'patches');

function run(command, args, cwd = rootDir, extra = {}) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
		env: {
			...process.env,
			...extra.env,
		},
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(' ')}`);
	}
}

function capture(command, args, cwd = rootDir, extra = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			...extra.env,
		},
	});

	if (result.status !== 0) {
		const stderr = result.stderr?.trim();
		throw new Error(stderr || `Command failed: ${command} ${args.join(' ')}`);
	}

	return result.stdout.trim();
}

function ensureParentDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function tryResolveRevision(checkoutDir, revision) {
	for (const candidate of [revision, `refs/tags/${revision}`, 'FETCH_HEAD']) {
		const result = spawnSync('git', ['rev-parse', '--verify', candidate], {
			cwd: checkoutDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		if (result.status === 0) {
			return result.stdout.trim();
		}
	}

	return null;
}

function ensureGitCheckout(config, checkoutDir) {
	if (!fs.existsSync(checkoutDir)) {
		fs.mkdirSync(path.dirname(checkoutDir), { recursive: true });
		run('git', ['clone', config.repository, checkoutDir, '--depth=1']);
	}

	let target = tryResolveRevision(checkoutDir, config.commit);
	if (target === null) {
		run('git', ['fetch', '--depth=1', 'origin', config.commit], checkoutDir);
		target = tryResolveRevision(checkoutDir, config.commit);
	}
	if (target === null) {
		run('git', ['fetch', '--depth=1', 'origin', 'tag', config.commit], checkoutDir);
		target = tryResolveRevision(checkoutDir, config.commit);
	}
	if (target === null) {
		throw new Error(`Unable to resolve ${config.commit} in ${checkoutDir}`);
	}

	const head = capture('git', ['rev-parse', 'HEAD'], checkoutDir);
	if (head !== target) {
		run('git', ['checkout', '--detach', target], checkoutDir);
	}
}

function applyNodePatches() {
	if (!fs.existsSync(patchesDir)) {
		return;
	}

	const patches = fs.readdirSync(patchesDir)
		.filter((file) => file.endsWith('.patch'))
		.sort();

	for (const patch of patches) {
		const patchPath = path.join(patchesDir, patch);
		const forward = spawnSync('git', ['apply', '--check', patchPath], { cwd: nodeCheckoutDir });
		if (forward.status === 0) {
			run('git', ['apply', patchPath], nodeCheckoutDir);
			continue;
		}

		const reverse = spawnSync('git', ['apply', '--reverse', '--check', patchPath], { cwd: nodeCheckoutDir });
		if (reverse.status !== 0) {
			throw new Error(`Patch does not apply cleanly: ${patch}`);
		}
	}
}

function ensureEmsdkInstalled() {
	const emsdkScript = path.join(emsdkDir, 'emsdk');
	run(emsdkScript, ['install', EMSDK_CONFIG.toolVersion], emsdkDir);
	run(emsdkScript, ['activate', EMSDK_CONFIG.toolVersion], emsdkDir);
}

function compileLlhttpWasm() {
	ensureParentDir(llhttpWasmOutputFile);

	const emcc = path.join(emsdkDir, 'upstream', 'emscripten', 'emcc');
	const emConfig = path.join(emsdkDir, '.emscripten');
	if (!fs.existsSync(emcc)) {
		throw new Error(`Missing emcc at ${emcc}`);
	}
	if (!fs.existsSync(emConfig)) {
		throw new Error(`Missing emsdk config at ${emConfig}`);
	}

	const llhttpDir = path.join(nodeCheckoutDir, 'deps', 'llhttp');
	const includeDir = path.join(llhttpDir, 'include');
	const sourceDir = path.join(llhttpDir, 'src');
	const exportedFunctions = [
		'_malloc',
		'_free',
		'_llhttp_wasm_alloc',
		'_llhttp_wasm_free',
		'_llhttp_wasm_init',
		'_llhttp_wasm_smoke_test',
		'_llhttp_execute',
		'_llhttp_finish',
		'_llhttp_pause',
		'_llhttp_resume',
		'_llhttp_resume_after_upgrade',
		'_llhttp_get_type',
		'_llhttp_get_http_major',
		'_llhttp_get_http_minor',
		'_llhttp_get_method',
		'_llhttp_get_status_code',
		'_llhttp_get_upgrade',
		'_llhttp_reset',
		'_llhttp_should_keep_alive',
		'_llhttp_get_errno',
		'_llhttp_get_error_reason',
		'_llhttp_get_error_pos',
		'_llhttp_errno_name',
		'_llhttp_set_lenient_headers',
		'_llhttp_set_lenient_chunked_length',
		'_llhttp_set_lenient_keep_alive',
		'_llhttp_set_lenient_transfer_encoding',
		'_llhttp_set_lenient_version',
		'_llhttp_set_lenient_data_after_close',
		'_llhttp_set_lenient_optional_lf_after_cr',
		'_llhttp_set_lenient_optional_crlf_after_chunk',
		'_llhttp_set_lenient_optional_cr_before_lf',
		'_llhttp_set_lenient_spaces_after_chunk_size',
	];

	run(
		emcc,
		[
			llhttpShimFile,
			path.join(sourceDir, 'api.c'),
			path.join(sourceDir, 'http.c'),
			path.join(sourceDir, 'llhttp.c'),
			`-I${includeDir}`,
			'-O3',
			'-sSTANDALONE_WASM=1',
			'-sFILESYSTEM=0',
			'-sERROR_ON_UNDEFINED_SYMBOLS=1',
			`-sEXPORTED_FUNCTIONS=${JSON.stringify(exportedFunctions)}`,
			'-Wl,--no-entry',
			'-o',
			llhttpWasmOutputFile,
		],
		rootDir,
		{
			env: {
				EM_CONFIG: emConfig,
			},
		},
	);
}

function emitLlhttpModule() {
	ensureParentDir(llhttpWasmModuleFile);
	const base64 = fs.readFileSync(llhttpWasmOutputFile).toString('base64');
	const contents = `const llhttpWasmBase64 = ${JSON.stringify(base64)};\n\nexport default llhttpWasmBase64;\n`;
	fs.writeFileSync(llhttpWasmModuleFile, contents);
}

ensureGitCheckout(nodeConfig, nodeCheckoutDir);
applyNodePatches();
ensureGitCheckout(EMSDK_CONFIG, emsdkDir);
ensureEmsdkInstalled();
compileLlhttpWasm();
emitLlhttpModule();
