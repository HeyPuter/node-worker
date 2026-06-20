import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
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
const cryptoShimFile = path.join(nodeWasmDir, 'crypto-shim.c');
const patchesDir = path.join(rootDir, 'node-patches');

// OpenSSL libcrypto is built straight from node's vendored tree so the version
// (3.5.5) and headers match. `linux-x32` is an ILP32 target that maps cleanly
// onto wasm32; `no-asm` is mandatory. The CROSS_COMPILE blanking fixes the
// emconfigure-mangled CC path. Only `libcrypto.a` is built (no TLS/libssl).
const opensslSourceDir = path.join(nodeCheckoutDir, 'deps', 'openssl', 'openssl');
const opensslBuildDir = path.join(nodeCheckoutDir, 'deps', 'openssl', 'wasm-build');
const opensslLibCrypto = path.join(opensslBuildDir, 'libcrypto.a');

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

function runAsync(command, args, extra = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: rootDir,
			stdio: ['ignore', 'inherit', 'inherit'],
			env: { ...process.env, ...extra.env },
		});
		child.on('error', reject);
		child.on('close', (status) => {
			if (status === 0) resolve();
			else reject(new Error(`Command failed: ${command} ${args.join(' ')}`));
		});
	});
}

// Run an array of thunks with bounded concurrency (one in flight per core).
async function runPool(thunks, concurrency) {
	let next = 0;
	const worker = async () => {
		while (next < thunks.length) {
			await thunks[next++]();
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, thunks.length) }, worker),
	);
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

function buildOpenSSL() {
	// Skip if already built — the libcrypto.a compile is the slowest step.
	if (fs.existsSync(opensslLibCrypto)) {
		return;
	}

	const emConfigure = path.join(emsdkDir, 'upstream', 'emscripten', 'emconfigure');
	const emMake = path.join(emsdkDir, 'upstream', 'emscripten', 'emmake');
	const emConfig = path.join(emsdkDir, '.emscripten');

	fs.mkdirSync(opensslBuildDir, { recursive: true });

	const configure = path.join(opensslSourceDir, 'Configure');
	run(
		emConfigure,
		[
			configure,
			'linux-x32',
			// Seed the DRBG via getrandom()/getentropy() instead of the default
			// OS path (which reads /dev/urandom — unavailable under FILESYSTEM=0).
			// -D__ELF__ enables the getentropy weak-symbol branch in
			// providers/.../seeding/rand_unix.c, which crypto-shim.c satisfies.
			'--with-rand-seed=getrandom',
			'no-asm', 'no-shared', 'no-dso', 'no-engine', 'no-afalgeng',
			'no-tests', 'no-threads', 'no-ui-console', 'no-comp', 'no-ocsp',
			'no-srp', 'no-cms', 'no-ts', 'no-ssl', 'no-tls', 'no-quic',
			'-D__ELF__',
			'-DOPENSSL_SYS_NETWARE', '-DHAVE_FORK=0', '-DOPENSSL_NO_DYNAMIC_ENGINE',
			'-DOPENSSL_NO_SECURE_MEMORY',
		],
		opensslBuildDir,
		{ env: { EM_CONFIG: emConfig } },
	);

	// emconfigure mangles CROSS_COMPILE into the CC path; blank it so CC is the
	// bare absolute emcc path.
	const makefilePath = path.join(opensslBuildDir, 'Makefile');
	const makefile = fs.readFileSync(makefilePath, 'utf8')
		.replace(/^CROSS_COMPILE.*$/m, 'CROSS_COMPILE=');
	fs.writeFileSync(makefilePath, makefile);

	run(
		emMake,
		['make', `-j${os.cpus().length}`, 'build_generated', 'libcrypto.a'],
		opensslBuildDir,
		{ env: { EM_CONFIG: emConfig } },
	);

	if (!fs.existsSync(opensslLibCrypto)) {
		throw new Error(`OpenSSL build did not produce ${opensslLibCrypto}`);
	}
}

async function compileNodeWorkerWasm() {
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
	// Generated headers (configuration.h, opensslconf.h) live in the build dir;
	// the rest of the public headers come from the source tree.
	const opensslBuildIncludeDir = path.join(opensslBuildDir, 'include');
	const opensslSrcIncludeDir = path.join(opensslSourceDir, 'include');

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

		// crypto shim (OpenSSL libcrypto)
		'_crypto_init',
		'_crypto_last_error',
		'_crypto_md_oneshot',
		'_crypto_md_new',
		'_crypto_md_copy',
		'_crypto_md_update',
		'_crypto_md_final',
		'_crypto_md_free',
		'_crypto_hmac_new',
		'_crypto_hmac_update',
		'_crypto_hmac_final',
		'_crypto_hmac_free',
		'_crypto_get_hashes',
		'_crypto_get_ciphers',
		'_crypto_get_curves',
		'_crypto_pbkdf2',
		'_crypto_scrypt',
		'_crypto_hkdf',
		'_crypto_cipher_new',
		'_crypto_cipher_update',
		'_crypto_cipher_final',
		'_crypto_cipher_set_aad',
		'_crypto_cipher_get_auth_tag',
		'_crypto_cipher_set_auth_tag',
		'_crypto_cipher_set_auto_padding',
		'_crypto_cipher_free',
		'_crypto_cipher_info',
		'_crypto_pkey_parse',
		'_crypto_pkey_free',
		'_crypto_pkey_up_ref',
		'_crypto_pkey_type',
		'_crypto_pkey_export',
		'_crypto_pkey_detail',
		'_crypto_generate_rsa',
		'_crypto_generate_ec',
		'_crypto_generate_ed',
		'_crypto_pkey_sign',
		'_crypto_pkey_verify',
		'_crypto_generate_secret',
		'_crypto_x509_parse',
		'_crypto_x509_free',
		'_crypto_x509_name',
		'_crypto_x509_fingerprint',
		'_crypto_x509_valid',
		'_crypto_x509_serial',
		'_crypto_x509_subject_alt_name',
		'_crypto_x509_info_access',
		'_crypto_x509_sig_alg',
		'_crypto_x509_raw',
		'_crypto_x509_pem',
		'_crypto_x509_public_key',
		'_crypto_x509_check_host',
		'_crypto_x509_check_email',
		'_crypto_x509_check_ip',
		'_crypto_x509_check_ca',
		'_crypto_x509_verify',
		'_crypto_x509_check_issued',
		'_crypto_rand_bytes',
		'_crypto_timing_safe_equal',
		'_crypto_smoke_test',
	];

	const sources = [
		llhttpShimFile,
		zlibShimFile,
		brotliShimFile,
		cryptoShimFile,
		path.join(llhttpSourceDir, 'api.c'),
		path.join(llhttpSourceDir, 'http.c'),
		path.join(llhttpSourceDir, 'llhttp.c'),
		...zlibSources,
		...brotliSources,
	];

	// Per-file compile flags (shared by every object). Passing the full include
	// set to every source is harmless and keeps the job uniform.
	const includes = [
		`-I${llhttpIncludeDir}`,
		`-I${zlibDir}`,
		`-I${brotliIncludeDir}`,
		`-I${opensslBuildIncludeDir}`,
		`-I${opensslSrcIncludeDir}`,
	];
	const compileFlags = [...includes, '-O3', '-ffunction-sections', '-fdata-sections'];

	// Compile each source to an object file in parallel (one job per core),
	// caching by source mtime. The whole object cache is invalidated whenever
	// the compile flags change.
	const objDir = path.join(wasmBuildDir, 'obj');
	fs.mkdirSync(objDir, { recursive: true });

	const flagsFile = path.join(objDir, '.compileflags');
	const flagsKey = JSON.stringify(compileFlags);
	if (!fs.existsSync(flagsFile) || fs.readFileSync(flagsFile, 'utf8') !== flagsKey) {
		for (const f of fs.readdirSync(objDir)) {
			if (f.endsWith('.o')) fs.rmSync(path.join(objDir, f));
		}
		fs.writeFileSync(flagsFile, flagsKey);
	}

	const objectFor = (src) =>
		path.join(objDir, path.relative(rootDir, src).replace(/[\\/]/g, '__').replace(/\.c$/, '.o'));

	const objects = sources.map(objectFor);
	const jobs = [];
	sources.forEach((src, i) => {
		const obj = objects[i];
		const fresh = fs.existsSync(obj) && fs.statSync(obj).mtimeMs >= fs.statSync(src).mtimeMs;
		if (fresh) return;
		jobs.push(() => runAsync(emcc, ['-c', src, ...compileFlags, '-o', obj], { env: { EM_CONFIG: emConfig } }));
	});

	const cores = os.cpus().length;
	if (jobs.length > 0) {
		console.log(`Compiling ${jobs.length}/${sources.length} wasm objects with ${cores} workers (${sources.length - jobs.length} cached)...`);
		await runPool(jobs, cores);
	} else {
		console.log(`All ${sources.length} wasm objects cached; linking only.`);
	}

	// Link the objects + libcrypto.a into the standalone wasm. libcrypto.a is
	// last so the linker resolves the crypto_* references; --gc-sections drops
	// the large unreferenced majority of libcrypto. This (binaryen -O3) is the
	// serial floor, so skip it when the output is already newer than every input
	// and the link flags are unchanged.
	const linkFlags = [
		'-O3',
		'-Wl,--gc-sections',
		'-sSTANDALONE_WASM=1',
		'-sFILESYSTEM=0',
		'-sALLOW_MEMORY_GROWTH=1',
		'-sERROR_ON_UNDEFINED_SYMBOLS=1',
		`-sEXPORTED_FUNCTIONS=${JSON.stringify(exportedFunctions)}`,
		'-Wl,--no-entry',
	];
	const linkFile = path.join(objDir, '.linkflags');
	const linkKey = JSON.stringify(linkFlags);
	const linkFlagsChanged = !fs.existsSync(linkFile) || fs.readFileSync(linkFile, 'utf8') !== linkKey;
	const newestInput = Math.max(
		fs.statSync(opensslLibCrypto).mtimeMs,
		...objects.map((o) => fs.statSync(o).mtimeMs),
	);
	const wasmFresh =
		!linkFlagsChanged &&
		fs.existsSync(wasmOutputFile) &&
		fs.statSync(wasmOutputFile).mtimeMs >= newestInput;
	if (wasmFresh) {
		console.log('wasm is up to date; skipping link.');
		return;
	}

	run(emcc, [...objects, opensslLibCrypto, ...linkFlags, '-o', wasmOutputFile], rootDir, {
		env: { EM_CONFIG: emConfig },
	});
	fs.writeFileSync(linkFile, linkKey);
}

function emitWasmModule() {
	// Skip re-encoding when the base64 module is already newer than the wasm.
	if (
		fs.existsSync(wasmModuleFile) &&
		fs.statSync(wasmModuleFile).mtimeMs >= fs.statSync(wasmOutputFile).mtimeMs
	) {
		return;
	}
	ensureParentDir(wasmModuleFile);
	const base64 = fs.readFileSync(wasmOutputFile).toString('base64');
	const contents = `const nodeWorkerWasmBase64 = ${JSON.stringify(base64)};\n\nexport default nodeWorkerWasmBase64;\n`;
	fs.writeFileSync(wasmModuleFile, contents);
}

// WASM_ONLY skips the (already-done) checkout/emsdk steps for fast wasm
// rebuilds during shim development.
if (!process.env.WASM_ONLY) {
	ensureGitCheckout(nodeConfig, nodeCheckoutDir);
	applyNodePatches();
	ensureGitCheckout(EMSDK_CONFIG, emsdkDir);
	ensureEmsdkInstalled();
}
buildOpenSSL();
await compileNodeWorkerWasm();
emitWasmModule();
