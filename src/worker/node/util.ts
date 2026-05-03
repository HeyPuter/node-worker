const kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom");
const kCustomPromisifyArgsSymbol = Symbol.for(
	"nodejs.util.promisify.customArgs"
);

function promisify(original: any): any {
	if (typeof original !== "function") {
		throw new TypeError("argument must be a function");
	}

	if (original[kCustomPromisifiedSymbol]) {
		const fn = original[kCustomPromisifiedSymbol];
		if (typeof fn !== "function") {
			throw new TypeError("custom promisified function must be a function");
		}
		Object.defineProperty(fn, kCustomPromisifiedSymbol, {
			value: fn,
			enumerable: false,
			writable: false,
			configurable: true,
		});
		return fn;
	}

	const argumentNames = original[kCustomPromisifyArgsSymbol];

	function fn(this: any, ...args: any[]) {
		return new Promise((resolve, reject) => {
			args.push((err: any, ...values: any[]) => {
				if (err) return reject(err);
				if (argumentNames !== undefined && values.length > 1) {
					const obj: any = {};
					for (let i = 0; i < argumentNames.length; i++) {
						obj[argumentNames[i]] = values[i];
					}
					resolve(obj);
				} else {
					resolve(values[0]);
				}
			});
			Reflect.apply(original, this, args);
		});
	}

	Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
	Object.defineProperty(fn, kCustomPromisifiedSymbol, {
		value: fn,
		enumerable: false,
		writable: false,
		configurable: true,
	});
	return Object.defineProperties(
		fn,
		Object.getOwnPropertyDescriptors(original)
	);
}

(promisify as any).custom = kCustomPromisifiedSymbol;

function format(fmt: any, ...args: any[]): string {
	if (typeof fmt !== "string") {
		return [fmt, ...args].map((a) => inspect(a)).join(" ");
	}

	let i = 0;
	let result = "";
	let lastEnd = 0;

	for (let pos = 0; pos < fmt.length - 1; pos++) {
		if (fmt.charCodeAt(pos) !== 0x25 /* % */) continue;
		const c = fmt.charCodeAt(++pos);
		if (i >= args.length) continue;

		let formatted: string;
		switch (c) {
			case 0x73: /* s */
				formatted = String(args[i++]);
				break;
			case 0x64: /* d */
				formatted = Number(args[i++]).toString();
				break;
			case 0x69: /* i */
				formatted = parseInt(args[i++] as any, 10).toString();
				break;
			case 0x66: /* f */
				formatted = parseFloat(args[i++] as any).toString();
				break;
			case 0x6a: /* j */
				try {
					formatted = JSON.stringify(args[i++]);
				} catch {
					formatted = "[Circular]";
				}
				break;
			case 0x6f: /* o */
			case 0x4f /* O */:
				formatted = inspect(args[i++]);
				break;
			case 0x25 /* % */:
				result += fmt.slice(lastEnd, pos);
				lastEnd = pos + 1;
				continue;
			default:
				continue;
		}

		result += fmt.slice(lastEnd, pos - 1) + formatted;
		lastEnd = pos + 1;
	}

	result += fmt.slice(lastEnd);
	while (i < args.length) {
		const a = args[i++];
		result += " " + (typeof a === "string" ? a : inspect(a));
	}
	return result;
}

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripVTControlCharacters(str: string): string {
	return String(str).replace(ANSI_RE, "");
}

function getStringWidth(str: string): number {
	return Array.from(stripVTControlCharacters(String(str))).length;
}

interface InspectOpts {
	depth?: number;
	colors?: boolean;
	showHidden?: boolean;
	maxArrayLength?: number;
	maxStringLength?: number;
	breakLength?: number;
	compact?: boolean | number;
	sorted?: boolean | ((a: string, b: string) => number);
}

function inspect(value: any, opts: InspectOpts = {}): string {
	const depth = opts.depth ?? 2;
	const seen = new WeakSet<object>();

	function fmt(v: any, currentDepth: number): string {
		if (v === null) return "null";
		if (v === undefined) return "undefined";
		const t = typeof v;
		if (t === "string") return JSON.stringify(v);
		if (t === "number" || t === "boolean" || t === "bigint")
			return String(v) + (t === "bigint" ? "n" : "");
		if (t === "symbol") return v.toString();
		if (t === "function") {
			const name = v.name || "(anonymous)";
			return `[Function: ${name}]`;
		}
		if (v instanceof Error) {
			return `${v.name}: ${v.message}${v.stack ? "\n" + v.stack : ""}`;
		}
		if (v instanceof Date) return v.toISOString();
		if (v instanceof RegExp) return v.toString();

		if (currentDepth < 0) {
			return Array.isArray(v) ? "[Array]" : "[Object]";
		}

		if (typeof v === "object") {
			if (seen.has(v)) return "[Circular]";
			seen.add(v);

			try {
				if (Array.isArray(v)) {
					const items = v.map((item) => fmt(item, currentDepth - 1));
					return `[ ${items.join(", ")} ]`;
				}

				const entries = Object.entries(v).map(
					([k, val]) => `${k}: ${fmt(val, currentDepth - 1)}`
				);
				const ctor =
					v.constructor && v.constructor.name && v.constructor.name !== "Object"
						? v.constructor.name + " "
						: "";
				return `${ctor}{ ${entries.join(", ")} }`;
			} finally {
				seen.delete(v);
			}
		}

		return String(v);
	}

	return fmt(value, depth);
}

function inherits(ctor: any, superCtor: any) {
	if (typeof superCtor !== "function" && superCtor !== null) {
		throw new TypeError("superCtor must be a function or null");
	}
	Object.defineProperty(ctor, "super_", {
		value: superCtor,
		enumerable: false,
		writable: true,
		configurable: true,
	});
	if (superCtor) {
		Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
	}
}

function deprecate<T extends (...args: any[]) => any>(fn: T, _msg: string): T {
	let warned = false;
	const wrapped = function (this: any, ...args: any[]) {
		if (!warned) {
			warned = true;
			if (typeof console !== "undefined" && console.warn) {
				console.warn(`(node:1) DeprecationWarning: ${_msg}`);
			}
		}
		return fn.apply(this, args);
	} as unknown as T;
	return wrapped;
}

const types = {
	isAnyArrayBuffer(v: any) {
		return v instanceof ArrayBuffer || v instanceof SharedArrayBuffer;
	},
	isArrayBuffer(v: any) {
		return v instanceof ArrayBuffer;
	},
	isSharedArrayBuffer(v: any) {
		return v instanceof SharedArrayBuffer;
	},
	isAsyncFunction(v: any) {
		return (
			typeof v === "function" && v.constructor && v.constructor.name === "AsyncFunction"
		);
	},
	isGeneratorFunction(v: any) {
		return (
			typeof v === "function" &&
			v.constructor &&
			v.constructor.name === "GeneratorFunction"
		);
	},
	isPromise(v: any) {
		return v instanceof Promise;
	},
	isMap(v: any) {
		return v instanceof Map;
	},
	isSet(v: any) {
		return v instanceof Set;
	},
	isWeakMap(v: any) {
		return v instanceof WeakMap;
	},
	isWeakSet(v: any) {
		return v instanceof WeakSet;
	},
	isRegExp(v: any) {
		return v instanceof RegExp;
	},
	isDate(v: any) {
		return v instanceof Date;
	},
	isNativeError(v: any) {
		return v instanceof Error;
	},
	isUint8Array(v: any) {
		return v instanceof Uint8Array;
	},
	isTypedArray(v: any) {
		return ArrayBuffer.isView(v) && !(v instanceof DataView);
	},
	isDataView(v: any) {
		return v instanceof DataView;
	},
};

const util = {
	promisify,
	format,
	formatWithOptions: (_opts: any, ...args: any[]) => format(args[0], ...args.slice(1)),
	inspect,
	stripVTControlCharacters,
	getStringWidth,
	inherits,
	deprecate,
	types,
	debuglog: (_section: string) => () => {},
	debug: (_section: string) => () => {},
	isArray: Array.isArray,
	isBoolean: (v: any) => typeof v === "boolean",
	isNull: (v: any) => v === null,
	isNullOrUndefined: (v: any) => v == null,
	isNumber: (v: any) => typeof v === "number",
	isString: (v: any) => typeof v === "string",
	isSymbol: (v: any) => typeof v === "symbol",
	isUndefined: (v: any) => v === undefined,
	isFunction: (v: any) => typeof v === "function",
	isObject: (v: any) => v !== null && typeof v === "object",
	isPrimitive: (v: any) => v === null || (typeof v !== "object" && typeof v !== "function"),
	isBuffer: (v: any) =>
		v != null && v.constructor != null && typeof v.constructor.isBuffer === "function" && v.constructor.isBuffer(v),
	TextEncoder,
	TextDecoder,
};

export default util as unknown as typeof import("node:util");
