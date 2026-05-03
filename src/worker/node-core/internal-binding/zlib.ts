// JS replacement for `internalBinding('zlib')`. Wraps pako 1.x's low-level
// deflate/inflate routines in the `Zlib` handle shape that
// `node_core/lib/zlib.js` expects (modern writeState + processCallback ABI).
// Brotli/Zstd handles throw on construction — pako doesn't speak those, and
// the worker doesn't need them today.

// @ts-ignore — pako 1.x exposes its zlib internals at these paths
import Zstream from "pako/lib/zlib/zstream.js";
// @ts-ignore
import * as zlib_deflate from "pako/lib/zlib/deflate.js";
// @ts-ignore
import * as zlib_inflate from "pako/lib/zlib/inflate.js";
// @ts-ignore
import pakoConstants from "pako/lib/zlib/constants.js";
// @ts-ignore
import pakoCrc32 from "pako/lib/zlib/crc32.js";

// node_zlib_mode values (must match constants.ts and node_zlib.cc enum order).
const NONE = 0;
const DEFLATE = 1;
const INFLATE = 2;
const GZIP = 3;
const GUNZIP = 4;
const DEFLATERAW = 5;
const INFLATERAW = 6;
const UNZIP = 7;

const Z_OK = pakoConstants.Z_OK;
const Z_STREAM_END = pakoConstants.Z_STREAM_END;
const Z_NEED_DICT = pakoConstants.Z_NEED_DICT;
const Z_BUF_ERROR = pakoConstants.Z_BUF_ERROR;
const Z_DATA_ERROR = pakoConstants.Z_DATA_ERROR;
const Z_FINISH = pakoConstants.Z_FINISH;
const Z_DEFLATED = pakoConstants.Z_DEFLATED;

const GZIP_HEADER_ID1 = 0x1f;
const GZIP_HEADER_ID2 = 0x8b;

const errnoToCode: Record<number, string> = {
	[-1]: "Z_ERRNO",
	[-2]: "Z_STREAM_ERROR",
	[-3]: "Z_DATA_ERROR",
	[-4]: "Z_MEM_ERROR",
	[-5]: "Z_BUF_ERROR",
	[-6]: "Z_VERSION_ERROR",
};

function isDeflateMode(mode: number): boolean {
	return mode === DEFLATE || mode === GZIP || mode === DEFLATERAW;
}
function isInflateMode(mode: number): boolean {
	return (
		mode === INFLATE ||
		mode === GUNZIP ||
		mode === INFLATERAW ||
		mode === UNZIP
	);
}

class Zlib {
	mode: number;
	strm: any = null;
	dictionary: Uint8Array | null = null;
	err: number = Z_OK;
	flush: number = pakoConstants.Z_NO_FLUSH;
	level: number = 0;
	memLevel: number = 0;
	strategy: number = 0;
	windowBits: number = 0;
	writeState: Uint32Array | null = null;
	processCallback: ((this: Zlib) => void) | null = null;
	onerror: ((msg: string, errno: number, code: string) => void) | null = null;
	gzip_id_bytes_read: number = 0;

	// Fields the JS wrapper attaches via `handle.foo = ...` and reads back
	// inside processCallback. Kept loose because node_core/lib/zlib.js owns them.
	[key: string]: any;

	constructor(mode: number) {
		if (typeof mode !== "number" || mode < DEFLATE || mode > UNZIP) {
			throw new TypeError(`Invalid zlib mode: ${mode}`);
		}
		this.mode = mode;
	}

	init(
		windowBits: number,
		level: number,
		memLevel: number,
		strategy: number,
		writeState: Uint32Array,
		processCallback: (this: Zlib) => void,
		dictionary?: Uint8Array
	) {
		this.writeState = writeState;
		this.processCallback = processCallback;
		this.level = level;
		this.memLevel = memLevel;
		this.strategy = strategy;

		// Adjust windowBits for the various wrappers — same trick as the C++
		// binding and browserify-zlib.
		let wb = windowBits;
		if (this.mode === GZIP || this.mode === GUNZIP) {
			wb += 16;
		} else if (this.mode === UNZIP) {
			wb += 32;
		} else if (this.mode === DEFLATERAW || this.mode === INFLATERAW) {
			wb = -wb;
		}
		this.windowBits = wb;

		this.strm = new Zstream();

		if (isDeflateMode(this.mode)) {
			this.err = zlib_deflate.deflateInit2(
				this.strm,
				level,
				Z_DEFLATED,
				wb,
				memLevel,
				strategy
			);
			if (this.err === Z_OK && dictionary) {
				this.err = zlib_deflate.deflateSetDictionary(this.strm, dictionary);
			}
		} else if (isInflateMode(this.mode)) {
			this.err = zlib_inflate.inflateInit2(this.strm, wb);
		} else {
			throw new Error(`Unsupported zlib mode: ${this.mode}`);
		}

		this.dictionary = dictionary ?? null;

		if (this.err !== Z_OK) {
			this._error("Init error");
		}
	}

	write(
		flush: number,
		input: Uint8Array | null,
		inOff: number,
		inLen: number,
		out: Uint8Array,
		outOff: number,
		outLen: number
	): this {
		queueMicrotask(() => {
			this._process(flush, input, inOff, inLen, out, outOff, outLen);
			this.processCallback?.call(this);
		});
		return this;
	}

	writeSync(
		flush: number,
		input: Uint8Array | null,
		inOff: number,
		inLen: number,
		out: Uint8Array,
		outOff: number,
		outLen: number
	): void {
		this._process(flush, input, inOff, inLen, out, outOff, outLen);
	}

	_process(
		flush: number,
		input: Uint8Array | null,
		inOff: number,
		inLen: number,
		out: Uint8Array,
		outOff: number,
		outLen: number
	) {
		if (input == null) {
			input = new Uint8Array(0);
			inLen = 0;
			inOff = 0;
		}

		this.strm.input = input;
		this.strm.next_in = inOff;
		this.strm.avail_in = inLen;
		this.strm.output = out;
		this.strm.next_out = outOff;
		this.strm.avail_out = outLen;
		this.flush = flush;

		// UNZIP auto-detects gzip vs deflate by sniffing the first two bytes.
		if (this.mode === UNZIP) {
			let probe: number | null = null;
			if (this.strm.avail_in > 0) probe = this.strm.next_in;

			if (this.gzip_id_bytes_read === 0) {
				if (probe !== null) {
					if (this.strm.input[probe] === GZIP_HEADER_ID1) {
						this.gzip_id_bytes_read = 1;
						probe++;
						if (this.strm.avail_in === 1) {
							// only one byte; defer second-byte check to next call
							this._writeBackState();
							return;
						}
					} else {
						this.mode = INFLATE;
					}
				}
			}
			if (this.gzip_id_bytes_read === 1 && this.mode === UNZIP) {
				if (probe !== null) {
					if (this.strm.input[probe] === GZIP_HEADER_ID2) {
						this.gzip_id_bytes_read = 2;
						this.mode = GUNZIP;
					} else {
						this.mode = INFLATE;
					}
				}
			}
		}

		if (isDeflateMode(this.mode)) {
			this.err = zlib_deflate.deflate(this.strm, flush);
		} else if (isInflateMode(this.mode)) {
			this.err = zlib_inflate.inflate(this.strm, flush);
			if (this.err === Z_NEED_DICT && this.dictionary) {
				this.err = zlib_inflate.inflateSetDictionary(this.strm, this.dictionary);
				if (this.err === Z_OK) {
					this.err = zlib_inflate.inflate(this.strm, flush);
				} else if (this.err === Z_DATA_ERROR) {
					// Both inflateSetDictionary() and inflate() return Z_DATA_ERROR;
					// surface the dictionary problem distinctly.
					this.err = Z_NEED_DICT;
				}
			}
			// Trailing concatenated gzip members.
			while (
				this.strm.avail_in > 0 &&
				this.mode === GUNZIP &&
				this.err === Z_STREAM_END &&
				this.strm.input[this.strm.next_in] !== 0x00
			) {
				this.reset();
				this.err = zlib_inflate.inflate(this.strm, flush);
			}
		} else {
			throw new Error(`Unknown zlib mode: ${this.mode}`);
		}

		this._writeBackState();
		this._checkError();
	}

	_writeBackState() {
		if (this.writeState) {
			// node's binding exposes [avail_out_after, avail_in_after].
			this.writeState[0] = this.strm.avail_out;
			this.writeState[1] = this.strm.avail_in;
		}
	}

	_checkError(): boolean {
		switch (this.err) {
			case Z_OK:
			case Z_BUF_ERROR:
				if (this.strm.avail_out !== 0 && this.flush === Z_FINISH) {
					this._error("unexpected end of file");
					return false;
				}
				break;
			case Z_STREAM_END:
				break;
			case Z_NEED_DICT:
				if (this.dictionary == null) {
					this._error("Missing dictionary");
				} else {
					this._error("Bad dictionary");
				}
				return false;
			default:
				this._error("Zlib error");
				return false;
		}
		return true;
	}

	_error(message: string) {
		const msg = this.strm?.msg || message;
		const code = errnoToCode[this.err] ?? "Z_UNKNOWN";
		if (this.onerror) {
			this.onerror(msg, this.err, code);
		} else {
			const err = new Error(msg) as Error & { errno: number; code: string };
			err.errno = this.err;
			err.code = code;
			throw err;
		}
	}

	params(_level: number, _strategy: number) {
		// pako doesn't expose deflateParams; node accepts no-op + a Z_SYNC_FLUSH
		// before the param change anyway, so dropping the change is safer than
		// throwing. Real zlib lets later writes still produce valid output.
	}

	reset() {
		if (isDeflateMode(this.mode)) {
			this.err = zlib_deflate.deflateReset(this.strm);
			if (this.err === Z_OK && this.dictionary) {
				this.err = zlib_deflate.deflateSetDictionary(this.strm, this.dictionary);
			}
		} else if (isInflateMode(this.mode)) {
			this.err = zlib_inflate.inflateReset(this.strm);
		}
		if (this.err !== Z_OK) {
			this._error("Failed to reset stream");
		}
	}

	close() {
		if (isDeflateMode(this.mode)) {
			zlib_deflate.deflateEnd(this.strm);
		} else if (isInflateMode(this.mode)) {
			zlib_inflate.inflateEnd(this.strm);
		}
		this.mode = NONE;
		this.dictionary = null;
		this.strm = null;
	}
}

class BrotliEncoder {
	constructor() {
		throw new Error(
			"Brotli compression is not supported in this runtime"
		);
	}
}

class BrotliDecoder {
	constructor() {
		throw new Error(
			"Brotli decompression is not supported in this runtime"
		);
	}
}

class ZstdCompress {
	constructor() {
		throw new Error("Zstd compression is not supported in this runtime");
	}
}

class ZstdDecompress {
	constructor() {
		throw new Error("Zstd decompression is not supported in this runtime");
	}
}

function crc32(data: Uint8Array, initial: number = 0): number {
	// pako's crc32 takes (crc, buf, len, pos)
	return pakoCrc32(initial, data, data.length, 0) >>> 0;
}

export default {
	Zlib,
	BrotliEncoder,
	BrotliDecoder,
	ZstdCompress,
	ZstdDecompress,
	crc32,
};
