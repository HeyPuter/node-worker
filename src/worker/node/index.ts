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
};
export default internalModules;
