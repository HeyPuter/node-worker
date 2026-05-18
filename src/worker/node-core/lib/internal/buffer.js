import { Buffer } from 'buffer';

// Mostly a pass-through to the npm `buffer` polyfill, with one difference:
// upstream's `FastBuffer` is `class FastBuffer extends Uint8Array {}`, so
// `new FastBuffer()` (no args) yields an empty buffer. The polyfill's
// `new Buffer()` rejects undefined input, which breaks callers like
// `ZlibBase.prototype._flush` that use a bare `new FastBuffer()` placeholder.
function FastBuffer(arg, encodingOrOffset, length) {
  if (arg === undefined) return Buffer.alloc(0);
  if (typeof arg === 'number') return Buffer.alloc(arg);
  return Buffer.from(arg, encodingOrOffset, length);
}
FastBuffer.prototype = Buffer.prototype;

export { FastBuffer };

export default {
  FastBuffer,
};
