import { Buffer } from 'buffer';

const kEmptyObject = Object.freeze(Object.create(null));
const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const platform = globalThis['process']?.platform ?? 'linux';
const isWindows = platform === 'win32';
const isMacOS = platform === 'darwin';
const kEnumerableProperty = {
  __proto__: null,
  enumerable: true,
};

function getLazy(fn) {
  let value;
  let loaded = false;
  return function lazy() {
    if (!loaded) {
      value = fn();
      loaded = true;
    }
    return value;
  };
}

function spliceOne(list, index) {
  list.splice(index, 1);
}

function once(fn) {
  let called = false;
  return function wrapped(...args) {
    if (called) {
      return;
    }
    called = true;
    return fn.apply(this, args);
  };
}

function assignFunctionName(name, fn, descriptor = kEmptyObject) {
  Object.defineProperty(fn, 'name', {
    __proto__: null,
    configurable: true,
    value: name,
    ...descriptor,
  });
  return fn;
}

function getConstructorOf(value) {
  return Object.getPrototypeOf(value)?.constructor;
}

function SideEffectFreeRegExpPrototypeSymbolReplace(regex, value, replacement) {
  return String.prototype.replace.call(value, regex, replacement);
}

function normalizeEncoding(encoding) {
  if (encoding == null || encoding === '') {
    return 'utf8';
  }

  const normalized = String(encoding).toLowerCase();
  return Buffer.isEncoding(normalized) ? normalized : undefined;
}

const kCustomPromisifiedSymbol = Symbol.for('nodejs.util.promisify.custom');

function promisify(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('The "original" argument must be of type function');
  }

  if (fn[kCustomPromisifiedSymbol]) {
    return fn[kCustomPromisifiedSymbol];
  }

  return function promisified(...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, value) => {
        if (err) {
          reject(err);
        } else {
          resolve(value);
        }
      });
    });
  };
}

promisify.custom = kCustomPromisifiedSymbol;

function deprecate(fn) {
  return fn;
}

// --- helpers needed by the upstream crypto layer (internal/crypto/*) ---------

// Crypto is available in this runtime (OpenSSL via wasm), so the guard is a
// no-op rather than the upstream throw.
function assertCrypto() {}

// Memoize a zero-arg function (getCiphers/getHashes/getCurves).
function cachedResult(fn) {
  let cache;
  let loaded = false;
  return function () {
    if (!loaded) {
      cache = fn();
      loaded = true;
    }
    return cache;
  };
}

const customPromisifyArgs = Symbol('customPromisifyArgs');

function emitExperimentalWarning() {}

// node maps encoding names to numeric ids consumed by the C++ StringBytes
// layer; our wasm binding ignores that id, so an empty map suffices.
const encodingsMap = { __proto__: null };

function filterDuplicateStrings(items, low) {
  const set = new Set();
  for (const item of items) {
    const s = String(item);
    set.add(low ? s.toLowerCase() : s);
  }
  return [...set].sort();
}

// Returns the "maybe emit" function; deprecation warnings are no-ops here.
function getDeprecationWarningEmitter() {
  return function () {};
}

function lazyDOMException(message, name) {
  try {
    return new DOMException(message, name);
  } catch {
    const err = new Error(message);
    err.name = name;
    return err;
  }
}

function setOwnProperty(obj, key, value) {
  Object.defineProperty(obj, key, {
    __proto__: null,
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  return true;
}

export {
  assertCrypto,
  assignFunctionName,
  cachedResult,
  customInspectSymbol,
  customPromisifyArgs,
  deprecate,
  emitExperimentalWarning,
  encodingsMap,
  filterDuplicateStrings,
  getConstructorOf,
  getDeprecationWarningEmitter,
  getLazy,
  isMacOS,
  isWindows,
  kEmptyObject,
  kEnumerableProperty,
  lazyDOMException,
  normalizeEncoding,
  once,
  promisify,
  setOwnProperty,
  SideEffectFreeRegExpPrototypeSymbolReplace,
  spliceOne,
};

export default {
  assertCrypto,
  assignFunctionName,
  cachedResult,
  customInspectSymbol,
  customPromisifyArgs,
  deprecate,
  emitExperimentalWarning,
  encodingsMap,
  filterDuplicateStrings,
  getConstructorOf,
  getDeprecationWarningEmitter,
  getLazy,
  isMacOS,
  isWindows,
  kEmptyObject,
  kEnumerableProperty,
  lazyDOMException,
  normalizeEncoding,
  once,
  promisify,
  setOwnProperty,
  SideEffectFreeRegExpPrototypeSymbolReplace,
  spliceOne,
};
