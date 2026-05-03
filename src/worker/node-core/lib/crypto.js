function unsupported(name) {
	return () => {
		throw new Error(`node:crypto.${name} is not supported in this runtime`);
	};
}

export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto?.subtle;
export const randomUUID = () => globalThis.crypto.randomUUID();
export const getRandomValues = (buf) => globalThis.crypto.getRandomValues(buf);
export const randomBytes = (size) => {
	const buf = new Uint8Array(size);
	globalThis.crypto.getRandomValues(buf);
	return buf;
};
export const constants = {};
export const createHash = unsupported('createHash');
export const createHmac = unsupported('createHmac');
export const createCipheriv = unsupported('createCipheriv');
export const createDecipheriv = unsupported('createDecipheriv');
export const createSign = unsupported('createSign');
export const createVerify = unsupported('createVerify');
export const generateKeyPair = unsupported('generateKeyPair');
export const generateKeyPairSync = unsupported('generateKeyPairSync');
export const pbkdf2 = unsupported('pbkdf2');
export const pbkdf2Sync = unsupported('pbkdf2Sync');
export const scrypt = unsupported('scrypt');
export const scryptSync = unsupported('scryptSync');
export const randomFill = unsupported('randomFill');
export const randomFillSync = unsupported('randomFillSync');
export const randomInt = unsupported('randomInt');
export const timingSafeEqual = unsupported('timingSafeEqual');

export default {
	webcrypto,
	subtle,
	randomUUID,
	getRandomValues,
	randomBytes,
	constants,
	createHash,
	createHmac,
	createCipheriv,
	createDecipheriv,
	createSign,
	createVerify,
	generateKeyPair,
	generateKeyPairSync,
	pbkdf2,
	pbkdf2Sync,
	scrypt,
	scryptSync,
	randomFill,
	randomFillSync,
	randomInt,
	timingSafeEqual,
};
