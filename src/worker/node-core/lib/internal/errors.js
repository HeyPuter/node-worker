function createNodeError(code, BaseError = Error, messageBuilder = (...args) => `${code}: ${args.map(String).join(' ')}`) {
  return class NodeError extends BaseError {
    constructor(...args) {
      super(messageBuilder(...args));
      this.code = code;
      this.name = `${this.constructor.name} [${code}]`;
    }
  };
}

const ERR_INVALID_ARG_TYPE = createNodeError(
  'ERR_INVALID_ARG_TYPE',
  TypeError,
  (name, expected, actual) => `The ${name} argument must be ${expected}; received ${actual}`,
);
const ERR_INVALID_ARG_VALUE = createNodeError(
  'ERR_INVALID_ARG_VALUE',
  TypeError,
  (name, value) => `The ${name} argument is invalid: ${value}`,
);
const ERR_INVALID_CURSOR_POS = createNodeError('ERR_INVALID_CURSOR_POS', RangeError, () => 'Cursor position must be a finite number');
const ERR_USE_AFTER_CLOSE = createNodeError('ERR_USE_AFTER_CLOSE', Error, () => 'Readline was used after being closed');
const ERR_ILLEGAL_CONSTRUCTOR = createNodeError('ERR_ILLEGAL_CONSTRUCTOR', TypeError, () => 'Illegal constructor');
const ERR_METHOD_NOT_IMPLEMENTED = createNodeError('ERR_METHOD_NOT_IMPLEMENTED', Error, (name) => `${name} is not implemented`);
const ERR_OUT_OF_RANGE = createNodeError('ERR_OUT_OF_RANGE', RangeError, (name, range, value) => `The value of ${name} is out of range. Expected ${range}; received ${value}`);
const ERR_UNKNOWN_ENCODING = createNodeError('ERR_UNKNOWN_ENCODING', TypeError, (encoding) => `Unknown encoding: ${encoding}`);
const ERR_MULTIPLE_CALLBACK = createNodeError('ERR_MULTIPLE_CALLBACK', Error, () => 'Callback called multiple times');
const ERR_STREAM_ALREADY_FINISHED = createNodeError('ERR_STREAM_ALREADY_FINISHED', Error, () => 'Stream already finished');
const ERR_STREAM_CANNOT_PIPE = createNodeError('ERR_STREAM_CANNOT_PIPE', Error, () => 'Cannot pipe, not readable');
const ERR_STREAM_DESTROYED = createNodeError('ERR_STREAM_DESTROYED', Error, (name = 'stream') => `${name} is destroyed`);
const ERR_STREAM_NULL_VALUES = createNodeError('ERR_STREAM_NULL_VALUES', TypeError, () => 'May not write null values to stream');
const ERR_STREAM_PREMATURE_CLOSE = createNodeError('ERR_STREAM_PREMATURE_CLOSE', Error, () => 'Premature close');
const ERR_STREAM_PUSH_AFTER_EOF = createNodeError('ERR_STREAM_PUSH_AFTER_EOF', Error, () => 'stream.push() after EOF');
const ERR_STREAM_UNSHIFT_AFTER_END_EVENT = createNodeError('ERR_STREAM_UNSHIFT_AFTER_END_EVENT', Error, () => 'stream.unshift() after end event');
const ERR_STREAM_WRITE_AFTER_END = createNodeError('ERR_STREAM_WRITE_AFTER_END', Error, () => 'write after end');
const ERR_INVALID_RETURN_VALUE = createNodeError('ERR_INVALID_RETURN_VALUE', TypeError, (input, name, value) => `Expected ${input} to be returned from ${name}, got ${value}`);
const ERR_MISSING_ARGS = createNodeError('ERR_MISSING_ARGS', TypeError, (...args) => `Missing required arguments: ${args.join(', ')}`);
const ERR_STREAM_UNABLE_TO_PIPE = createNodeError('ERR_STREAM_UNABLE_TO_PIPE', Error, () => 'Cannot pipe to this destination');
const ERR_UNHANDLED_ERROR = createNodeError('ERR_UNHANDLED_ERROR', Error, (context) => `Unhandled error${context ? ` (${context})` : ''}`);

const ERR_INVALID_STATE = createNodeError('ERR_INVALID_STATE', Error, (message = 'Invalid state') => message);
ERR_INVALID_STATE.TypeError = createNodeError('ERR_INVALID_STATE', TypeError, (message = 'Invalid state') => message);

class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = undefined) {
    super(message, options);
    this.code = 'ABORT_ERR';
    this.name = 'AbortError';
  }
}

function aggregateTwoErrors(first, second) {
  if (first == null) {
    return second;
  }
  if (second == null || first === second) {
    return first;
  }

  const error = second instanceof Error ? second : new Error(String(second));
  error.errors = [first, second];
  return error;
}

function genericNodeError(message, options = undefined) {
  const error = new Error(message, options);
  if (options?.code) {
    error.code = options.code;
  }
  return error;
}

function hideStackFrames(fn) {
  return fn;
}

const codes = {
  ERR_ILLEGAL_CONSTRUCTOR,
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_INVALID_CURSOR_POS,
  ERR_INVALID_RETURN_VALUE,
  ERR_INVALID_STATE,
  ERR_METHOD_NOT_IMPLEMENTED,
  ERR_MISSING_ARGS,
  ERR_MULTIPLE_CALLBACK,
  ERR_OUT_OF_RANGE,
  ERR_STREAM_ALREADY_FINISHED,
  ERR_STREAM_CANNOT_PIPE,
  ERR_STREAM_DESTROYED,
  ERR_STREAM_NULL_VALUES,
  ERR_STREAM_PREMATURE_CLOSE,
  ERR_STREAM_PUSH_AFTER_EOF,
  ERR_STREAM_UNABLE_TO_PIPE,
  ERR_STREAM_UNSHIFT_AFTER_END_EVENT,
  ERR_STREAM_WRITE_AFTER_END,
  ERR_UNHANDLED_ERROR,
  ERR_UNKNOWN_ENCODING,
  ERR_USE_AFTER_CLOSE,
};

export {
  AbortError,
  aggregateTwoErrors,
  codes,
  genericNodeError,
  hideStackFrames,
};

export default {
  AbortError,
  aggregateTwoErrors,
  codes,
  genericNodeError,
  hideStackFrames,
};
