import { Buffer } from 'buffer';

const FastBuffer = Buffer[Symbol.species] || Buffer;

export { FastBuffer };

export default {
  FastBuffer,
};
