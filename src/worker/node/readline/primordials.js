"use strict";

const SymbolDispose = Symbol.dispose || Symbol.for("Symbol.dispose");
const SymbolAsyncIterator = Symbol.asyncIterator;

class SafeStringIterator {
	constructor(str) {
		this._iterator = String(str)[Symbol.iterator]();
	}

	next() {
		return this._iterator.next();
	}

	[Symbol.iterator]() {
		return this;
	}
}

function toSorted(arr) {
	if (typeof arr.toSorted === "function") {
		return arr.toSorted();
	}
	return [...arr].sort();
}

module.exports = {
	ArrayFrom: Array.from,
	ArrayPrototypeFilter: (arr, fn) => arr.filter(fn),
	ArrayPrototypeJoin: (arr, sep) => arr.join(sep),
	ArrayPrototypeMap: (arr, fn) => arr.map(fn),
	ArrayPrototypePop: (arr) => arr.pop(),
	ArrayPrototypePush: (arr, ...items) => arr.push(...items),
	ArrayPrototypeReverse: (arr) => arr.reverse(),
	ArrayPrototypeShift: (arr) => arr.shift(),
	ArrayPrototypeToSorted: (arr) => toSorted(arr),
	ArrayPrototypeUnshift: (arr, ...items) => arr.unshift(...items),
	DateNow: Date.now,
	FunctionPrototypeBind: (fn, thisArg, ...args) => fn.bind(thisArg, ...args),
	FunctionPrototypeCall: (fn, thisArg, ...args) => fn.call(thisArg, ...args),
	MathCeil: Math.ceil,
	MathFloor: Math.floor,
	MathMax: Math.max,
	MathMaxApply: (arr) => Math.max(...arr),
	NumberIsFinite: Number.isFinite,
	NumberIsNaN: Number.isNaN,
	ObjectDefineProperties: Object.defineProperties,
	ObjectDefineProperty: Object.defineProperty,
	ObjectSetPrototypeOf: Object.setPrototypeOf,
	Promise,
	PromiseReject: Promise.reject.bind(Promise),
	RegExpPrototypeExec: (re, str) => re.exec(str),
	SafeStringIterator,
	StringFromCharCode: String.fromCharCode,
	StringPrototypeCharCodeAt: (str, idx) => str.charCodeAt(idx),
	StringPrototypeCodePointAt: (str, idx) => str.codePointAt(idx),
	StringPrototypeEndsWith: (str, suffix) => str.endsWith(suffix),
	StringPrototypeIncludes: (str, search) => str.includes(search),
	StringPrototypeRepeat: (str, count) => str.repeat(count),
	StringPrototypeReplaceAll: (str, from, to) =>
		typeof str.replaceAll === "function"
			? str.replaceAll(from, to)
			: str.split(from).join(to),
	StringPrototypeSlice: (str, start, end) => str.slice(start, end),
	StringPrototypeSplit: (str, sep) => str.split(sep),
	StringPrototypeStartsWith: (str, prefix) => str.startsWith(prefix),
	StringPrototypeToLowerCase: (str) => str.toLowerCase(),
	Symbol,
	SymbolAsyncIterator,
	SymbolDispose,
};
