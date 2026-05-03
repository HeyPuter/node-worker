function unsupported(name) {
	return () => {
		throw new Error(`node:tls.${name} is not supported in this runtime`);
	};
}

class Stub {
	constructor() {
		throw new Error('node:tls class is not supported in this runtime');
	}
}

export const TLSSocket = Stub;
export const Server = Stub;
export const SecureContext = Stub;
export const createServer = unsupported('createServer');
export const createSecureContext = () => ({});
export const connect = unsupported('connect');
export const checkServerIdentity = () => undefined;
export const rootCertificates = [];
export const DEFAULT_ECDH_CURVE = 'auto';
export const DEFAULT_MAX_VERSION = 'TLSv1.3';
export const DEFAULT_MIN_VERSION = 'TLSv1.2';
export const DEFAULT_CIPHERS = '';

export default {
	TLSSocket,
	Server,
	SecureContext,
	createServer,
	createSecureContext,
	connect,
	checkServerIdentity,
	rootCertificates,
	DEFAULT_ECDH_CURVE,
	DEFAULT_MAX_VERSION,
	DEFAULT_MIN_VERSION,
	DEFAULT_CIPHERS,
};
