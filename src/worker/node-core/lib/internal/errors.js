function createNodeError(code, BaseError = Error, messageBuilder = (...args) => `${code}: ${args.map(String).join(' ')}`) {
  class NodeError extends BaseError {
    constructor(...args) {
      super(messageBuilder(...args));
      this.code = code;
      this.name = `${this.constructor.name} [${code}]`;
    }
  }

  NodeError.HideStackFramesError = NodeError;
  return NodeError;
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
const ERR_INVALID_URL = createNodeError(
  'ERR_INVALID_URL',
  TypeError,
  (input) => `Invalid URL: ${input}`,
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
const ERR_INVALID_CHAR = createNodeError('ERR_INVALID_CHAR', TypeError, (name, field = '') => `Invalid character in ${name}${field ? ` [${field}]` : ''}`);
const ERR_INVALID_HTTP_TOKEN = createNodeError('ERR_INVALID_HTTP_TOKEN', TypeError, (name, value) => `${name} must be a valid HTTP token: ${value}`);
const ERR_INVALID_PROTOCOL = createNodeError('ERR_INVALID_PROTOCOL', TypeError, (protocol, expected) => `Protocol "${protocol}" not supported. Expected "${expected}"`);
const ERR_UNESCAPED_CHARACTERS = createNodeError('ERR_UNESCAPED_CHARACTERS', TypeError, (name) => `${name} contains unescaped characters`);
const ERR_HTTP_HEADERS_SENT = createNodeError('ERR_HTTP_HEADERS_SENT', Error, (action) => `Cannot ${action} headers after they are sent to the client`);
const ERR_HTTP_INVALID_STATUS_CODE = createNodeError('ERR_HTTP_INVALID_STATUS_CODE', RangeError, (statusCode) => `Invalid status code: ${statusCode}`);
const ERR_HTTP_REQUEST_TIMEOUT = createNodeError('ERR_HTTP_REQUEST_TIMEOUT', Error, () => 'Request timeout');
const ERR_HTTP_SOCKET_ASSIGNED = createNodeError('ERR_HTTP_SOCKET_ASSIGNED', Error, () => 'Socket is already assigned');
const ERR_HTTP_SOCKET_ENCODING = createNodeError('ERR_HTTP_SOCKET_ENCODING', Error, () => 'Changing the socket encoding is not allowed');
const ERR_HTTP_BODY_NOT_ALLOWED = createNodeError('ERR_HTTP_BODY_NOT_ALLOWED', Error, () => 'Adding content for this request method or response status is not allowed');
const ERR_HTTP_CONTENT_LENGTH_MISMATCH = createNodeError('ERR_HTTP_CONTENT_LENGTH_MISMATCH', Error, (written, expected) => `Content-Length mismatch: wrote ${written}, expected ${expected}`);
const ERR_HTTP_INVALID_HEADER_VALUE = createNodeError('ERR_HTTP_INVALID_HEADER_VALUE', TypeError, (value, name) => `Invalid value "${value}" for header "${name}"`);
const ERR_HTTP_TRAILER_INVALID = createNodeError('ERR_HTTP_TRAILER_INVALID', Error, () => 'Trailers are invalid with this transfer encoding');
const ERR_PROXY_INVALID_CONFIG = createNodeError('ERR_PROXY_INVALID_CONFIG', TypeError, (value) => `Invalid proxy configuration: ${value}`);

const ERR_INVALID_STATE = createNodeError('ERR_INVALID_STATE', Error, (message = 'Invalid state') => message);
ERR_INVALID_STATE.TypeError = createNodeError('ERR_INVALID_STATE', TypeError, (message = 'Invalid state') => message);

class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = undefined) {
    super(message, options);
    this.code = 'ABORT_ERR';
    this.name = 'AbortError';
  }
}

class ConnResetException extends Error {
  constructor(message = 'socket hang up') {
    super(message);
    this.code = 'ECONNRESET';
    this.name = 'ConnResetException';
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
  ERR_INVALID_URL,
  ERR_INVALID_CHAR,
  ERR_INVALID_CURSOR_POS,
  ERR_INVALID_HTTP_TOKEN,
  ERR_INVALID_PROTOCOL,
  ERR_INVALID_RETURN_VALUE,
  ERR_INVALID_STATE,
  ERR_HTTP_BODY_NOT_ALLOWED,
  ERR_HTTP_CONTENT_LENGTH_MISMATCH,
  ERR_HTTP_HEADERS_SENT,
  ERR_HTTP_INVALID_HEADER_VALUE,
  ERR_HTTP_INVALID_STATUS_CODE,
  ERR_HTTP_REQUEST_TIMEOUT,
  ERR_HTTP_SOCKET_ASSIGNED,
  ERR_HTTP_SOCKET_ENCODING,
  ERR_HTTP_TRAILER_INVALID,
  ERR_METHOD_NOT_IMPLEMENTED,
  ERR_MISSING_ARGS,
  ERR_MULTIPLE_CALLBACK,
  ERR_OUT_OF_RANGE,
  ERR_PROXY_INVALID_CONFIG,
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
  ERR_UNESCAPED_CHARACTERS,
  ERR_UNKNOWN_ENCODING,
  ERR_USE_AFTER_CLOSE,
};

export {
  AbortError,
  ConnResetException,
  aggregateTwoErrors,
  codes,
  genericNodeError,
  hideStackFrames,
};

export default {
  AbortError,
  ConnResetException,
  aggregateTwoErrors,
  codes,
  genericNodeError,
  hideStackFrames,
};
