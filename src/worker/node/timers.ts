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
