// `inspect`/`format`/`formatWithOptions`/`getStringWidth`/`stripVTControlCharacters`
// and `types` all come from upstream Node via the Rollup fallthrough (backed by
// the pure-JS `internalBinding('types')`/`('util')`/`('config')` shims). This
// gives real Node inspect fidelity — Map/Set/TypedArray/getter rendering,
// depth/breakLength/compact layout, circular refs, and colors that honor
// options — while promisify/inherits/deprecate/legacy `is*` helpers stay local.
// @ts-ignore resolved by the worker Rollup pipeline.
import types from "node-core:util/types";
// @ts-ignore resolved by the worker Rollup pipeline.
import inspectModule from "node-core:internal/util/inspect";

const { inspect, format, formatWithOptions, getStringWidth, stripVTControlCharacters } =
	inspectModule;

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

const util = {
	promisify,
	format,
	formatWithOptions,
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
