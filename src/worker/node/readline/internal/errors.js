"use strict";

class AbortError extends Error {
	constructor(message = "The operation was aborted", options = undefined) {
		super(message);
		this.name = "AbortError";
		this.code = "ABORT_ERR";
		if (options && "cause" in options) {
			this.cause = options.cause;
		}
	}
}

class ERR_INVALID_ARG_VALUE extends TypeError {
	constructor(name, value) {
		super(`The argument '${name}' is invalid. Received ${String(value)}`);
		this.code = "ERR_INVALID_ARG_VALUE";
	}
}

class ERR_INVALID_CURSOR_POS extends RangeError {
	constructor() {
		super("Cannot set cursor row without also setting its column");
		this.code = "ERR_INVALID_CURSOR_POS";
	}
}

class ERR_INVALID_ARG_TYPE extends TypeError {
	constructor(name, expected, actual) {
		super(
			`The '${name}' argument must be of type ${expected}. Received ${typeof actual}`
		);
		this.code = "ERR_INVALID_ARG_TYPE";
	}
}

class ERR_USE_AFTER_CLOSE extends Error {
	constructor(resource) {
		super(`Cannot call ${resource} after close`);
		this.code = "ERR_USE_AFTER_CLOSE";
	}
}

module.exports = {
	AbortError,
	codes: {
		ERR_INVALID_ARG_TYPE,
		ERR_INVALID_ARG_VALUE,
		ERR_INVALID_CURSOR_POS,
		ERR_USE_AFTER_CLOSE,
	},
};
