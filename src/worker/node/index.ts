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
import { createRequire } from "../module/cjs";
export { depromisify, streamToBuffer } from "./utils";

let internalModules = {
	events,
	stream,
	"stream/promises": streamPromises,
	buffer,
	path,
	util,
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
	"timers/promises": timersPromises,

	tls,
	crypto,
	url,
	https,

	"perf_hooks": { performance: globalThis.performance },
	"module": { createRequire: createRequire, builtinModules: null as any },
	"tty": { isatty() { return true } },
	"worker_threads": { MessageChannel: globalThis.MessageChannel, Worker: {} },
	"assert": {},
	"v8": {},
	// todo polyfill
	"querystring": {},
};
internalModules["module"].builtinModules = internalModules;
export default internalModules;
