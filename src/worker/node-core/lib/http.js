function unsupported(name) {
	return () => {
		throw new Error(`node:http.${name} is not supported in this runtime`);
	};
}

class Stub {
	constructor() {
		throw new Error('node:http class is not supported in this runtime');
	}
}

export const Agent = Stub;
export const Server = Stub;
export const ClientRequest = Stub;
export const IncomingMessage = Stub;
export const ServerResponse = Stub;
export const OutgoingMessage = Stub;
export const createServer = unsupported('createServer');
export const request = unsupported('request');
export const get = unsupported('get');
export const STATUS_CODES = {};
export const METHODS = [];
export const globalAgent = {};

export default {
	Agent,
	Server,
	ClientRequest,
	IncomingMessage,
	ServerResponse,
	OutgoingMessage,
	createServer,
	request,
	get,
	STATUS_CODES,
	METHODS,
	globalAgent,
};
