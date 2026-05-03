import { codes } from './errors.js';

const kValidateObjectAllowObjects = 1;
const kValidateObjectAllowObjectsAndNull = 2;

function validateFunction(value, name) {
  if (typeof value !== 'function') {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'function', value);
  }
}

function validateString(value, name) {
  if (typeof value !== 'string') {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'string', value);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'boolean', value);
  }
}

function validateNumber(value, name) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'number', value);
  }
}

function validateInteger(value, name, min = undefined, max = undefined) {
  if (!Number.isInteger(value)) {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'integer', value);
  }
  if (min != null && value < min) {
    throw new codes.ERR_OUT_OF_RANGE(name, `>= ${min}`, value);
  }
  if (max != null && value > max) {
    throw new codes.ERR_OUT_OF_RANGE(name, `<= ${max}`, value);
  }
}

function validateUint32(value, name) {
  validateInteger(value, name, 0, 0xFFFFFFFF);
}

function validateObject(value, name, flags = 0) {
  if (value == null) {
    if (flags === kValidateObjectAllowObjectsAndNull) {
      return;
    }
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
  if (typeof value !== 'object' && !(flags & kValidateObjectAllowObjects)) {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}

function validateAbortSignal(value, name) {
  if (value == null) {
    return;
  }
  if (typeof value !== 'object' || typeof value.aborted !== 'boolean') {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'AbortSignal', value);
  }
}

function validateOneOf(value, name, values) {
  if (!values.includes(value)) {
    throw new codes.ERR_INVALID_ARG_VALUE(name, value);
  }
}

function validateArray(value, name) {
  if (!Array.isArray(value)) {
    throw new codes.ERR_INVALID_ARG_TYPE(name, 'Array', value);
  }
}

export {
  kValidateObjectAllowObjects,
  kValidateObjectAllowObjectsAndNull,
  validateAbortSignal,
  validateArray,
  validateBoolean,
  validateFunction,
  validateInteger,
  validateNumber,
  validateObject,
  validateOneOf,
  validateString,
  validateUint32,
};

export default {
  kValidateObjectAllowObjects,
  kValidateObjectAllowObjectsAndNull,
  validateAbortSignal,
  validateArray,
  validateBoolean,
  validateFunction,
  validateInteger,
  validateNumber,
  validateObject,
  validateOneOf,
  validateString,
  validateUint32,
};
