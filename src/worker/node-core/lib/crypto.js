import crypto from '../../node/crypto';

export const webcrypto = crypto.webcrypto;
export const subtle = crypto.subtle;
export const randomUUID = crypto.randomUUID;
export const getRandomValues = crypto.getRandomValues;
export const randomBytes = crypto.randomBytes;
export const constants = crypto.constants;
export const createHash = crypto.createHash;
export const createHmac = crypto.createHmac;
export const createCipheriv = crypto.createCipheriv;
export const createDecipheriv = crypto.createDecipheriv;
export const createSign = crypto.createSign;
export const createVerify = crypto.createVerify;
export const generateKeyPair = crypto.generateKeyPair;
export const generateKeyPairSync = crypto.generateKeyPairSync;
export const pbkdf2 = crypto.pbkdf2;
export const pbkdf2Sync = crypto.pbkdf2Sync;
export const scrypt = crypto.scrypt;
export const scryptSync = crypto.scryptSync;
export const randomFill = crypto.randomFill;
export const randomFillSync = crypto.randomFillSync;
export const randomInt = crypto.randomInt;
export const timingSafeEqual = crypto.timingSafeEqual;

export default crypto;
