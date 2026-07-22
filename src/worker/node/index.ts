import fs from "./fs";
import net from "./net";
import http from "./http";
import process from "./process";
import events from "./events";
import stream from "./stream";
import streamPromises from "./stream-promises";
import buffer from "./buffer";
import path from "./path";
import util from "./util";
import zlib from "./zlib";
import readline from "./readline";
import readlinePromises from "./readline-promises";
import childProcess from "./child_process";
import os from "./os";
import dns from "./dns";
import timersPromises from "./timers-promises";
import tls from "./tls";
import https from "./https";
import crypto from "./crypto";
import url from "./url";
import stringDecoder from "./string_decoder";
import querystring from "./querystring";
import assert from "./assert";
import diagnosticsChannel from "./diagnostics_channel";
import workerThreads from "./worker_threads";
import vm from "./vm";
import constants from "./constants";
import http2 from "./http2";
import asyncHooks from "./async_hooks";
import console from "./console";
import timers from "./timers";
import utilTypes from "./util-types";
import { createRequire } from "../module/cjs";
export { depromisify, streamToBuffer } from "./utils";

// TODO
(performance as any).markResourceTiming = () => {};

let internalModules = {
	events,
	stream,
	"stream/promises": streamPromises,
	buffer,
	path,
	util,
	"util/types": utilTypes,
	zlib,
	fs,
	net,
	http,
	"fs/promises": fs.promises,
	process,
	readline,
	"readline/promises": readlinePromises,
	child_process: childProcess,
	os,
	dns,
	"dns/promises": dns.promises,
	timers,
	"timers/promises": timersPromises,

	tls,
	crypto,
	url,
	string_decoder: stringDecoder,
	querystring,
	assert,
	"assert/strict": assert.strict,
	diagnostics_channel: diagnosticsChannel,
	worker_threads: workerThreads,
	https,
	vm,
	constants,

	"perf_hooks": { performance: globalThis.performance },
	"module": { createRequire: createRequire, builtinModules: null as any },
	"tty": { isatty() { return true } },
	"v8": {},
	http2,
	async_hooks: asyncHooks,
	console,
};
internalModules["module"].builtinModules = Object.keys(internalModules);
export default internalModules;
