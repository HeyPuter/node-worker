"use strict";

function isWritable(stream) {
	return !!stream && typeof stream.write === "function";
}

module.exports = {
	isWritable,
};
