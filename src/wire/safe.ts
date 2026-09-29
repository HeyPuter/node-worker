// The wire runs after user code has had a chance to replace builtins. Capture the
// methods that frame and route internal messages before any program is evaluated.
// This module is shared by the page, worker, and service worker and has no imports.
const uncurry = Function.prototype.bind.bind(Function.prototype.call) as <
	T extends (...args: any[]) => any,
>(
	fn: T
) => (self: any, ...args: any[]) => ReturnType<T>;

export const safe = Object.freeze({
	Promise,
	Error,
	promiseResolve: Promise.resolve.bind(Promise),
	promiseThen: uncurry(Promise.prototype.then) as <T, R1 = T, R2 = never>(
		promise: Promise<T>,
		onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
		onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
	) => Promise<R1 | R2>,
	promiseCatch: uncurry(Promise.prototype.catch) as <T, R = never>(
		promise: Promise<T>,
		onrejected: (reason: any) => R | PromiseLike<R>
	) => Promise<T | R>,
	Map,
	Uint8Array,
	DataView,
	TextEncoder,
	TextDecoder,
	jsonStringify: JSON.stringify.bind(JSON),
	jsonParse: JSON.parse.bind(JSON),
	objectKeys: Object.keys.bind(Object),
	mapGet: uncurry(Map.prototype.get),
	mapSet: uncurry(Map.prototype.set),
	mapDelete: uncurry(Map.prototype.delete),
	mapClear: uncurry(Map.prototype.clear),
	mapHas: uncurry(Map.prototype.has),
	mapValues: uncurry(Map.prototype.values),
	mapForEach: uncurry(Map.prototype.forEach),
	arrayPush: uncurry(Array.prototype.push),
	arrayPop: uncurry(Array.prototype.pop),
	arraySlice: uncurry(Array.prototype.slice),
	arrayJoin: uncurry(Array.prototype.join),
	arrayFilter: uncurry(Array.prototype.filter) as <T>(
		array: readonly T[],
		predicate: (value: T, index: number) => boolean
	) => T[],
	arrayMap: uncurry(Array.prototype.map) as <T, U>(
		array: readonly T[],
		fn: (value: T, index: number) => U
	) => U[],
	objectAssign: Object.assign.bind(Object),
	u8Set: uncurry(Uint8Array.prototype.set),
	u8Subarray: uncurry(Uint8Array.prototype.subarray),
	arrayBufferSlice: uncurry(ArrayBuffer.prototype.slice),
	dataViewGetUint16: uncurry(DataView.prototype.getUint16),
	dataViewGetUint32: uncurry(DataView.prototype.getUint32),
	dataViewSetUint16: uncurry(DataView.prototype.setUint16),
	dataViewSetUint32: uncurry(DataView.prototype.setUint32),
	textEncode: uncurry(TextEncoder.prototype.encode),
	textDecode: uncurry(TextDecoder.prototype.decode),
	stringCharCodeAt: uncurry(String.prototype.charCodeAt),
	stringSplit: uncurry(String.prototype.split) as (
		value: string,
		separator: string | RegExp
	) => string[],
	stringSlice: uncurry(String.prototype.slice),
	stringStartsWith: uncurry(String.prototype.startsWith),
	stringEndsWith: uncurry(String.prototype.endsWith),
	stringIncludes: uncurry(String.prototype.includes),
	stringLastIndexOf: uncurry(String.prototype.lastIndexOf),
	messagePortPost: uncurry(MessagePort.prototype.postMessage),
	messagePortStart: uncurry(MessagePort.prototype.start),
	messagePortClose: uncurry(MessagePort.prototype.close),
});
