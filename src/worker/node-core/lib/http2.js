function unsupported(name) {
	return () => {
		throw new Error(`node:http2.${name} is not supported in this runtime`);
	};
}

class Stub {
	constructor() {
		throw new Error('node:http2 class is not supported in this runtime');
	}
}

export const constants = {};
export const Http2ServerRequest = Stub;
export const Http2ServerResponse = Stub;
export const createServer = unsupported('createServer');
export const createSecureServer = unsupported('createSecureServer');
export const connect = unsupported('connect');
export const getDefaultSettings = () => ({});
export const getPackedSettings = () => new Uint8Array();
export const getUnpackedSettings = () => ({});

export default {
	constants,
	Http2ServerRequest,
	Http2ServerResponse,
	createServer,
	createSecureServer,
	connect,
	getDefaultSettings,
	getPackedSettings,
	getUnpackedSettings,
};
