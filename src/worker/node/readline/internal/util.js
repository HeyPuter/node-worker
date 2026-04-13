"use strict";

const { promisify } = require("util");

const kEmptyObject = Object.freeze({});

function assignFunctionName(name, fn) {
	const desc = typeof name === "symbol" ? name.description || "symbol" : name;
	try {
		Object.defineProperty(fn, "name", {
			configurable: true,
			value: String(desc),
		});
	} catch {
		// ignored
	}
	return fn;
}

module.exports = {
	assignFunctionName,
	kEmptyObject,
	promisify,
};
