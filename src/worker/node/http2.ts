// node:http2 — thin re-export of the real upstream lib/http2.js, wired to the
// nghttp2-wasm binding (internal-binding/http2) + the JS byte-pump patch in
// internal/http2/core.js. Client only: `http2.connect()` works;
// `createServer`/`createSecureServer` throw (no inbound TLS/ALPN listener).
// @ts-ignore resolved by the worker Rollup pipeline.
import http2 from "node-core:http2";

export const constants = http2.constants;
export const connect = http2.connect;
export const getDefaultSettings = http2.getDefaultSettings;
export const getPackedSettings = http2.getPackedSettings;
export const getUnpackedSettings = http2.getUnpackedSettings;
export const sensitiveHeaders = http2.sensitiveHeaders;
export const Http2ServerRequest = http2.Http2ServerRequest;
export const Http2ServerResponse = http2.Http2ServerResponse;
export const createServer = http2.createServer;
export const createSecureServer = http2.createSecureServer;
export const Http2Session = http2.Http2Session;
export const Http2Stream = http2.Http2Stream;
export const ServerHttp2Session = http2.ServerHttp2Session;

export default http2 as typeof import("node:http2");
