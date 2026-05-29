function unsupported(name: string) {
	return () => {
		throw new Error(`node:tls.${name} is not supported in this runtime`);
	};
}

class Stub {
	constructor() {
		throw new Error("node:tls class is not supported in this runtime");
	}
}

const TLSSocket = Stub;
const Server = Stub;
const SecureContext = Stub;
const createServer = unsupported("createServer");
const createSecureContext = () => ({});
const connect = unsupported("connect");
const checkServerIdentity = () => undefined;
const rootCertificates: string[] = [];
const DEFAULT_ECDH_CURVE = "auto";
const DEFAULT_MAX_VERSION = "TLSv1.3";
const DEFAULT_MIN_VERSION = "TLSv1.2";
const DEFAULT_CIPHERS = "";

const tls = {
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

export default tls as unknown as typeof import("node:tls");
