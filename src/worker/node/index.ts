import fs from "./fs";
import net from "./net";
import { events, stream, buffer, path, util, zlib } from "./polyfills";
export { depromisify, streamToBuffer } from "./utils";

let internalModules = {
	events,
	stream,
	buffer,
	path,
	util,
	zlib,
	fs,
	net,
	"fs/promises": fs.promises,
	process,
};
export default internalModules;
