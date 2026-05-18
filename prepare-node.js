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
const wasmBuildDir = path.join(nodeCheckoutDir, 'wasm-build');
const wasmOutputFile = path.join(wasmBuildDir, 'node-worker.wasm');
const wasmModuleFile = path.join(wasmBuildDir, 'node-worker.wasm.js');
const nodeWasmDir = path.join(rootDir, 'src', 'worker', 'node-wasm');
const llhttpShimFile = path.join(nodeWasmDir, 'llhttp-shim.c');
const zlibShimFile = path.join(nodeWasmDir, 'zlib-shim.c');
const brotliShimFile = path.join(nodeWasmDir, 'brotli-shim.c');
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

function compileNodeWorkerWasm() {
	ensureParentDir(wasmOutputFile);

	const emcc = path.join(emsdkDir, 'upstream', 'emscripten', 'emcc');
	const emConfig = path.join(emsdkDir, '.emscripten');
	if (!fs.existsSync(emcc)) {
		throw new Error(`Missing emcc at ${emcc}`);
	}
	if (!fs.existsSync(emConfig)) {
		throw new Error(`Missing emsdk config at ${emConfig}`);
	}

	const llhttpDir = path.join(nodeCheckoutDir, 'deps', 'llhttp');
	const llhttpIncludeDir = path.join(llhttpDir, 'include');
	const llhttpSourceDir = path.join(llhttpDir, 'src');
	const zlibDir = path.join(nodeCheckoutDir, 'deps', 'zlib');
	const brotliDir = path.join(nodeCheckoutDir, 'deps', 'brotli', 'c');
	const brotliIncludeDir = path.join(brotliDir, 'include');

	// Portable subset — leaves SIMD (adler32_simd, crc32_simd, crc_folding,
	// slide_hash_simd, cpu_features) and unused file-I/O code (gz*, compress,
	// uncompr, infback) out of the build.
	const zlibSources = [
		'adler32.c',
		'crc32.c',
		'deflate.c',
		'inffast.c',
		'inflate.c',
		'inftrees.c',
		'trees.c',
		'zutil.c',
	].map((name) => path.join(zlibDir, name));

	// Mirrors `deps/brotli/brotli.gyp:brotli_sources`.
	const brotliSources = [
		'common/constants.c',
		'common/context.c',
		'common/dictionary.c',
		'common/platform.c',
		'common/shared_dictionary.c',
		'common/transform.c',
		'dec/bit_reader.c',
		'dec/decode.c',
		'dec/huffman.c',
		'dec/prefix.c',
		'dec/state.c',
		'dec/static_init.c',
		'enc/backward_references.c',
		'enc/backward_references_hq.c',
		'enc/bit_cost.c',
		'enc/block_splitter.c',
		'enc/brotli_bit_stream.c',
		'enc/cluster.c',
		'enc/command.c',
		'enc/compound_dictionary.c',
		'enc/compress_fragment.c',
		'enc/compress_fragment_two_pass.c',
		'enc/dictionary_hash.c',
		'enc/encode.c',
		'enc/encoder_dict.c',
		'enc/entropy_encode.c',
		'enc/fast_log.c',
		'enc/histogram.c',
		'enc/literal_cost.c',
		'enc/memory.c',
		'enc/metablock.c',
		'enc/static_dict.c',
		'enc/static_dict_lut.c',
		'enc/static_init.c',
		'enc/utf8_util.c',
	].map((name) => path.join(brotliDir, name));

	const exportedFunctions = [
		'_malloc',
		'_free',

		// llhttp shim
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

		// zlib shim
		'_zlib_alloc',
		'_zlib_init',
		'_zlib_ensure_in_buf',
		'_zlib_ensure_out_buf',
		'_zlib_write',
		'_zlib_avail_in',
		'_zlib_avail_out',
		'_zlib_get_err',
		'_zlib_get_msg',
		'_zlib_params',
		'_zlib_reset',
		'_zlib_end',
		'_zlib_crc32_buf',
		'_zlib_smoke_test',

		// brotli shim
		'_brotli_alloc',
		'_brotli_init',
		'_brotli_ensure_in_buf',
		'_brotli_ensure_out_buf',
		'_brotli_write',
		'_brotli_avail_in',
		'_brotli_avail_out',
		'_brotli_get_err',
		'_brotli_get_msg',
		'_brotli_end',
	];

	run(
		emcc,
		[
			llhttpShimFile,
			zlibShimFile,
			brotliShimFile,
			path.join(llhttpSourceDir, 'api.c'),
			path.join(llhttpSourceDir, 'http.c'),
			path.join(llhttpSourceDir, 'llhttp.c'),
			...zlibSources,
			...brotliSources,
			`-I${llhttpIncludeDir}`,
			`-I${zlibDir}`,
			`-I${brotliIncludeDir}`,
			'-O3',
			'-sSTANDALONE_WASM=1',
			'-sFILESYSTEM=0',
			'-sALLOW_MEMORY_GROWTH=1',
			'-sERROR_ON_UNDEFINED_SYMBOLS=1',
			`-sEXPORTED_FUNCTIONS=${JSON.stringify(exportedFunctions)}`,
			'-Wl,--no-entry',
			'-o',
			wasmOutputFile,
		],
		rootDir,
		{
			env: {
				EM_CONFIG: emConfig,
			},
		},
	);
}

function emitWasmModule() {
	ensureParentDir(wasmModuleFile);
	const base64 = fs.readFileSync(wasmOutputFile).toString('base64');
	const contents = `const nodeWorkerWasmBase64 = ${JSON.stringify(base64)};\n\nexport default nodeWorkerWasmBase64;\n`;
	fs.writeFileSync(wasmModuleFile, contents);
}

ensureGitCheckout(nodeConfig, nodeCheckoutDir);
applyNodePatches();
ensureGitCheckout(EMSDK_CONFIG, emsdkDir);
ensureEmsdkInstalled();
compileNodeWorkerWasm();
emitWasmModule();
