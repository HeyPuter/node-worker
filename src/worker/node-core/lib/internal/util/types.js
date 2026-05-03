const toString = Object.prototype.toString;

function isArrayBuffer(value) {
  return value instanceof ArrayBuffer;
}

function isAnyArrayBuffer(value) {
  return value instanceof ArrayBuffer || toString.call(value) === '[object SharedArrayBuffer]';
}

function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

function isUint8Array(value) {
  return value instanceof Uint8Array;
}

function isDataView(value) {
  return value instanceof DataView;
}

function isAsyncFunction(value) {
  return typeof value === 'function' && value.constructor?.name === 'AsyncFunction';
}

function isRegExp(value) {
  return value instanceof RegExp;
}

export {
  isAnyArrayBuffer,
  isArrayBuffer,
  isArrayBufferView,
  isAsyncFunction,
  isDataView,
  isRegExp,
  isUint8Array,
};

export default {
  isAnyArrayBuffer,
  isArrayBuffer,
  isArrayBufferView,
  isAsyncFunction,
  isDataView,
  isRegExp,
  isUint8Array,
};
