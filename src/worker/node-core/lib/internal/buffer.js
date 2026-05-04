import { Buffer } from 'buffer';

// Aliased to Buffer because our `lib/buffer.js` doesn't perform upstream's
// `Buffer.prototype = FastBuffer.prototype` overlay; a plain Uint8Array
// subclass here would lack Buffer methods.
const FastBuffer = Buffer;

export { FastBuffer };

export default {
  FastBuffer,
};
