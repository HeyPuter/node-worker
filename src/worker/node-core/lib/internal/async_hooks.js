// Minimal `internal/async_hooks` shim. The full upstream module is built
// around the C++ async-hook tracking machinery; the worker only needs the
// `symbols` it exposes (zlib.js attaches the handle to its stream via
// `handle[owner_symbol]`).

export const symbols = {
	async_id_symbol: Symbol('asyncId'),
	trigger_async_id_symbol: Symbol('triggerAsyncId'),
	init_symbol: Symbol('init'),
	before_symbol: Symbol('before'),
	after_symbol: Symbol('after'),
	destroy_symbol: Symbol('destroy'),
	promise_resolve_symbol: Symbol('promiseResolve'),
	owner_symbol: Symbol('owner_symbol'),
};

export const constants = {
	kInit: 0,
	kBefore: 1,
	kAfter: 2,
	kDestroy: 3,
	kTotals: 4,
	kPromiseResolve: 5,
};

export function getHookArrays() {
	return [[], []];
}

export function executionAsyncId() {
	return 0;
}

export function triggerAsyncId() {
	return 0;
}

export function emitInit() {}
export function emitBefore() {}
export function emitAfter() {}
export function emitDestroy() {}
export function pushAsyncContext() {}
export function popAsyncContext() {}

// Unique, monotonically increasing async ids. Async-hook tracking itself is a
// no-op here, but upstream internal/timers.js uses this value as each Timeout's
// identity: `Timeout[Symbol.toPrimitive]` returns it and `knownTimersById` is
// keyed by it, so `+timer` / `clearTimeout(id)` need distinct ids per timer.
// Starts at 1 so a valid id is always truthy.
let nextAsyncId = 1;
export function newAsyncId() {
	return nextAsyncId++;
}

export function getOrSetAsyncId(object) {
	if (object && Object.prototype.hasOwnProperty.call(object, symbols.async_id_symbol)) {
		return object[symbols.async_id_symbol];
	}
	if (object) {
		object[symbols.async_id_symbol] = 0;
	}
	return 0;
}

export function getDefaultTriggerAsyncId() {
	return 0;
}

export function defaultTriggerAsyncIdScope(_triggerAsyncId, block, ...args) {
	return Reflect.apply(block, null, args);
}

export function initHooksExist() {
	return false;
}

export default {
	symbols,
	constants,
	getHookArrays,
	executionAsyncId,
	triggerAsyncId,
	emitInit,
	emitBefore,
	emitAfter,
	emitDestroy,
	pushAsyncContext,
	popAsyncContext,
	newAsyncId,
	getOrSetAsyncId,
	getDefaultTriggerAsyncId,
	defaultTriggerAsyncIdScope,
	initHooksExist,
};
