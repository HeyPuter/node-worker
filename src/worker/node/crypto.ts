function unsupported(name: string) {
	return () => {
		throw new Error(`node:crypto.${name} is not supported in this runtime`);
	};
}

const webcrypto = globalThis.crypto;
const subtle = globalThis.crypto?.subtle;
const randomUUID = () => globalThis.crypto.randomUUID();
const getRandomValues = <T extends ArrayBufferView | null>(buf: T): T =>
	globalThis.crypto.getRandomValues(buf as any);
const randomBytes = (size: number) => {
	const buf = new Uint8Array(size);
	globalThis.crypto.getRandomValues(buf);
	return buf;
};
const constants = {};

const crypto = {
	webcrypto,
	subtle,
	randomUUID,
	getRandomValues,
	randomBytes,
	constants,
	createHash: unsupported("createHash"),
	createHmac: unsupported("createHmac"),
	createCipheriv: unsupported("createCipheriv"),
	createDecipheriv: unsupported("createDecipheriv"),
	createSign: unsupported("createSign"),
	createVerify: unsupported("createVerify"),
	generateKeyPair: unsupported("generateKeyPair"),
	generateKeyPairSync: unsupported("generateKeyPairSync"),
	pbkdf2: unsupported("pbkdf2"),
	pbkdf2Sync: unsupported("pbkdf2Sync"),
	scrypt: unsupported("scrypt"),
	scryptSync: unsupported("scryptSync"),
	randomFill: unsupported("randomFill"),
	randomFillSync: unsupported("randomFillSync"),
	randomInt: unsupported("randomInt"),
	timingSafeEqual: unsupported("timingSafeEqual"),
};

export default crypto as unknown as typeof import("node:crypto");
