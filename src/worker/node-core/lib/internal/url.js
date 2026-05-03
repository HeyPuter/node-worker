// Minimal `internal/url` override. Upstream is ~1700 lines built around the
// C++ URL parser; we just expose the few names internal node JS modules
// actually destructure.

const URL = globalThis.URL;
const URLSearchParams = globalThis.URLSearchParams;

function isURL(value) {
  return value instanceof URL;
}

function fileURLToPath(url) {
  const u = url instanceof URL ? url : new URL(url);
  if (u.protocol !== 'file:') {
    throw new TypeError(`The URL must be of scheme file, received ${u.protocol}`);
  }
  return decodeURIComponent(u.pathname);
}

function pathToFileURL(p) {
  return new URL('file://' + (p.startsWith('/') ? p : '/' + p));
}

function toPathIfFileURL(input) {
  if (!isURL(input)) return input;
  return fileURLToPath(input);
}

function URLParse(input, base) {
  return URL.parse(input, base);
}

export {
  URL,
  URLSearchParams,
  URLParse,
  isURL,
  fileURLToPath,
  pathToFileURL,
  toPathIfFileURL,
};

export default {
  URL,
  URLSearchParams,
  URLParse,
  isURL,
  fileURLToPath,
  pathToFileURL,
  toPathIfFileURL,
};
