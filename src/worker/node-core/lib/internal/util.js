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

export {
  assignFunctionName,
  customInspectSymbol,
  deprecate,
  getConstructorOf,
  getLazy,
  isMacOS,
  isWindows,
  kEmptyObject,
  kEnumerableProperty,
  normalizeEncoding,
  once,
  promisify,
  SideEffectFreeRegExpPrototypeSymbolReplace,
  spliceOne,
};

export default {
  assignFunctionName,
  customInspectSymbol,
  deprecate,
  getConstructorOf,
  getLazy,
  isMacOS,
  isWindows,
  kEmptyObject,
  kEnumerableProperty,
  normalizeEncoding,
  once,
  promisify,
  SideEffectFreeRegExpPrototypeSymbolReplace,
  spliceOne,
};
