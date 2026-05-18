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

function validateFiniteNumber(number, name) {
  if (number === undefined) return false;
  if (typeof number === 'number' && Number.isNaN(number)) return false;
  validateNumber(number, name);
  if (!Number.isFinite(number)) {
    throw new codes.ERR_OUT_OF_RANGE(name, 'a finite number', number);
  }
  return true;
}

function checkRangesOrGetDefault(number, name, lower, upper, def) {
  if (!validateFiniteNumber(number, name)) {
    return def;
  }
  if (number < lower || number > upper) {
    throw new codes.ERR_OUT_OF_RANGE(name, `>= ${lower} and <= ${upper}`, number);
  }
  return number;
}

function validateLinkHeaderValue(value) {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (typeof entry !== 'string') {
				throw new codes.ERR_INVALID_ARG_TYPE('hints.link', 'string[]', value);
			}
		}
		return value.join(', ');
	}
	throw new codes.ERR_INVALID_ARG_TYPE('hints.link', ['string', 'string[]'], value);
}

export {
  kValidateObjectAllowObjects,
  kValidateObjectAllowObjectsAndNull,
  checkRangesOrGetDefault,
  validateAbortSignal,
  validateArray,
  validateBoolean,
  validateFiniteNumber,
  validateFunction,
  validateInteger,
  validateLinkHeaderValue,
  validateNumber,
  validateObject,
  validateOneOf,
  validateString,
  validateUint32,
};

export default {
  kValidateObjectAllowObjects,
  kValidateObjectAllowObjectsAndNull,
  checkRangesOrGetDefault,
  validateAbortSignal,
  validateArray,
  validateBoolean,
  validateFiniteNumber,
  validateFunction,
  validateInteger,
  validateLinkHeaderValue,
  validateNumber,
  validateObject,
  validateOneOf,
  validateString,
  validateUint32,
};
