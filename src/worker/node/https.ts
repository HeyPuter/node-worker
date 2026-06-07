// @ts-ignore resolved by the worker Rollup pipeline.
import https from "node-core:https";

// Stock node:https — an http.Agent subclass whose createConnection() calls
// tls.connect(), plus request()/get(). Works on top of our node:tls (epoxy)
// and the same _http_* internals that back node:http. TLS *servers*
// (https.createServer) are unsupported because node:tls.Server throws.
export default https as typeof import("node:https");
