import { CWD } from "./state";

// @ts-ignore
import events from "node-external:events";
let nodeEvents = events as typeof import("node:events");
// @ts-ignore
import stream from "node-external:stream";
let nodeStream = stream as typeof import("node:stream");
// @ts-ignore
import buffer from "node-external:buffer";
let nodeBuffer = buffer as typeof import("node:buffer");
// @ts-ignore
import path from "node-external:path";
let nodePath = path as typeof import("node:path");
// @ts-ignore
import util from "node-external:util";
let nodeUtil = util as typeof import("node:util");
// @ts-ignore
import zlib from "node-external:zlib";
let nodeZlib = zlib as typeof import("node:zlib");
// @ts-ignore
import process from "node-external:process";
let nodeProcess = process as typeof import("node:process");

nodeProcess.versions.node = "25.6.1";
nodeProcess.cwd = () => {
	return CWD;
}

export {
	nodeEvents as events,
	nodeStream as stream,
	nodeBuffer as buffer,
	nodePath as path,
	nodeUtil as util,
	nodeZlib as zlib,
	nodeProcess as process,
};
