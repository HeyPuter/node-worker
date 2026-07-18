// Node-style timer wrappers. Returns Timeout/Immediate objects with
// ref/unref/refresh/hasRef so code like `setInterval(fn, n).unref()` (used by
// node-core's _http_server.js) works. The objects also expose
// `Symbol.toPrimitive` returning the underlying browser handle id so callers
// that hold onto the return value purely as a numeric token still work with
// our wrapped clearTimeout/clearInterval.
//
// When the keepalive runtime is enabled, refed timers contribute to the
// shared ref count. Unrefed timers do not.

import * as keepalive from "../keepalive";
import timersPromises from "./timers-promises";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);

type Callback = (...args: any[]) => void;

class Timeout {
	private _cb: Callback;
	private _args: any[];
	private _msecs: number;
	private _repeat: boolean;
	private _id: any = undefined;
	private _refed: boolean = true;
	private _settled: boolean = false;

	constructor(cb: Callback, msecs: number, args: any[], repeat: boolean) {
		this._cb = cb;
		this._args = args;
		this._msecs = msecs;
		this._repeat = repeat;
		this._arm();
		keepalive.ref();
	}

	private _arm() {
		if (this._repeat) {
			this._id = realSetInterval(() => this._fire(), this._msecs, ...this._args);
		} else {
			this._id = realSetTimeout((...a: any[]) => {
				this._settled = true;
				if (this._refed) keepalive.unref();
				this._cb(...a);
			}, this._msecs, ...this._args);
		}
	}

	private _fire() {
		try {
			this._cb(...this._args);
		} catch (e) {
			queueMicrotask(() => {
				throw e;
			});
		}
	}

	ref(): this {
		if (this._settled) return this;
		if (!this._refed) {
			this._refed = true;
			keepalive.ref();
		}
		return this;
	}

	unref(): this {
		if (this._settled) return this;
		if (this._refed) {
			this._refed = false;
			keepalive.unref();
		}
		return this;
	}

	hasRef(): boolean {
		return this._refed && !this._settled;
	}

	refresh(): this {
		if (this._settled) return this;
		if (this._id !== undefined) {
			if (this._repeat) realClearInterval(this._id);
			else realClearTimeout(this._id);
		}
		this._arm();
		return this;
	}

	close() {
		if (this._settled) return;
		this._settled = true;
		if (this._id !== undefined) {
			if (this._repeat) realClearInterval(this._id);
			else realClearTimeout(this._id);
			this._id = undefined;
		}
		if (this._refed) keepalive.unref();
	}

	[Symbol.toPrimitive]() {
		return this._id ?? 0;
	}

	[Symbol.dispose]() {
		this.close();
	}
}

class Immediate {
	private _cb: Callback;
	private _args: any[];
	private _id: any = undefined;
	private _refed: boolean = true;
	private _settled: boolean = false;

	constructor(cb: Callback, args: any[]) {
		this._cb = cb;
		this._args = args;
		this._id = realSetTimeout((...a: any[]) => {
			this._settled = true;
			if (this._refed) keepalive.unref();
			this._cb(...a);
		}, 0, ...args);
		keepalive.ref();
	}

	ref(): this {
		if (this._settled) return this;
		if (!this._refed) {
			this._refed = true;
			keepalive.ref();
		}
		return this;
	}

	unref(): this {
		if (this._settled) return this;
		if (this._refed) {
			this._refed = false;
			keepalive.unref();
		}
		return this;
	}

	hasRef(): boolean {
		return this._refed && !this._settled;
	}

	close() {
		if (this._settled) return;
		this._settled = true;
		if (this._id !== undefined) {
			realClearTimeout(this._id);
			this._id = undefined;
		}
		if (this._refed) keepalive.unref();
	}

	[Symbol.toPrimitive]() {
		return this._id ?? 0;
	}

	[Symbol.dispose]() {
		this.close();
	}
}

export function setTimeoutWrap(cb: Callback, msecs?: number, ...args: any[]): Timeout {
	return new Timeout(cb, msecs ?? 0, args, false);
}

export function setIntervalWrap(cb: Callback, msecs?: number, ...args: any[]): Timeout {
	return new Timeout(cb, msecs ?? 0, args, true);
}

export function setImmediateWrap(cb: Callback, ...args: any[]): Immediate {
	return new Immediate(cb, args);
}

export function clearTimeoutWrap(t: any) {
	if (t instanceof Timeout) t.close();
	else if (t != null) realClearTimeout(t as any);
}

export function clearIntervalWrap(t: any) {
	if (t instanceof Timeout) t.close();
	else if (t != null) realClearInterval(t as any);
}

export function clearImmediateWrap(t: any) {
	if (t instanceof Immediate) t.close();
	else if (t != null) realClearTimeout(t as any);
}

export { Timeout, Immediate };

// Legacy libtimers API (deprecated upstream but still exported by node:timers).
// Unlike the class-based handles above, these operate on plain "timer objects"
// carrying `_idleTimeout` / `_onTimeout`, keeping the underlying handle on
// `_timer`. Rarely used, but a handful of older libraries still rely on them.
function insertLegacy(item: any, refed: boolean) {
	const msecs = item._idleTimeout;
	if (typeof msecs !== "number" || msecs < 0) return;
	if (item._timer) item._timer.close();
	item._timer = setTimeoutWrap(() => {
		if (typeof item._onTimeout === "function") item._onTimeout();
	}, msecs);
	if (!refed) item._timer.unref();
}

export function enroll(item: any, msecs: number) {
	if (typeof msecs !== "number" || msecs < 0 || !Number.isFinite(msecs)) {
		throw new RangeError("msecs must be a non-negative finite number");
	}
	unenroll(item);
	item._idleTimeout = msecs;
}

export function unenroll(item: any) {
	if (item._timer) {
		item._timer.close();
		item._timer = undefined;
	}
	item._idleTimeout = -1;
}

export function active(item: any) {
	insertLegacy(item, true);
}

export function _unrefActive(item: any) {
	insertLegacy(item, false);
}

// The `node:timers` module. Uses the same wrappers as the installed globals, so
// a timer created here can be cleared via the global clear* and vice versa.
// `promises` is a getter (like upstream) so the timers/promises module is only
// referenced lazily, sidestepping the timers <-> timers-promises import cycle.
const timers = {
	setTimeout: setTimeoutWrap,
	clearTimeout: clearTimeoutWrap,
	setInterval: setIntervalWrap,
	clearInterval: clearIntervalWrap,
	setImmediate: setImmediateWrap,
	clearImmediate: clearImmediateWrap,
	active,
	_unrefActive,
	enroll,
	unenroll,
	get promises() {
		return timersPromises;
	},
};

export default timers as unknown as typeof import("node:timers");
