"use strict";

const { inspect } = require("util");

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripVTControlCharacters(str) {
	return String(str).replace(ANSI_RE, "");
}

function getStringWidth(str) {
	return Array.from(stripVTControlCharacters(str)).length;
}

module.exports = {
	getStringWidth,
	inspect,
	stripVTControlCharacters,
};
