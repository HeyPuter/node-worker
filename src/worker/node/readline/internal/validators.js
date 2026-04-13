"use strict";

const {
	codes: { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE },
} = require("./errors");

function validateFunction(value, name) {
	if (typeof value !== "function") {
		throw new ERR_INVALID_ARG_TYPE(name, "function", value);
	}
}

function validateString(value, name) {
	if (typeof value !== "string") {
		throw new ERR_INVALID_ARG_TYPE(name, "string", value);
	}
}

function validateBoolean(value, name) {
	if (typeof value !== "boolean") {
		throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
	}
}

function validateInteger(
	value,
	name,
	min = Number.MIN_SAFE_INTEGER,
	max = Number.MAX_SAFE_INTEGER
) {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new ERR_INVALID_ARG_VALUE(name, value);
	}
}

function validateUint32(value, name) {
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
		throw new ERR_INVALID_ARG_VALUE(name, value);
	}
}

function validateAbortSignal(value, name) {
	if (
		value == null ||
		typeof value !== "object" ||
		typeof value.aborted !== "boolean"
	) {
		throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", value);
	}
}

module.exports = {
	validateAbortSignal,
	validateBoolean,
	validateFunction,
	validateInteger,
	validateString,
	validateUint32,
};
