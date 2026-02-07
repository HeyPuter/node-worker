import polyfills from "node-stdlib-browser";

export default {
	events: polyfills.events,
	stream: polyfills.stream,
	buffer: polyfills.buffer,
	path: polyfills.path,
	util: polyfills.util,
	zlib: polyfills.zlib,
};
