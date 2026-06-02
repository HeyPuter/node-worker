// JS replacement for node's `internalBinding(name)` C++ bridge. Resolves the
// names that bundled `node_core/lib/*.js` modules ask for. Anything unmapped
// throws so we notice at runtime rather than silently producing undefined.
//
// To support a new upstream module, add an entry here. Throwing C++-shaped
// stubs (tcp_wrap, pipe_wrap, ...) belong in `./stubs.ts`.

import zlibBinding from "./zlib";
import constants from "./constants";
import streamWrap from "./stream_wrap";
import uv from "./uv";
import modules from "./modules";
import url from "./url";
import urlPattern from "./url_pattern";
import encodingBinding from "./encoding_binding";
import utilBinding from "./util";
import fs from "./fs";
import httpParser from "./http_parser/index.js";
import cryptoBinding from "./crypto";

const bindings: Record<string, any> = {
	zlib: zlibBinding,
	constants,
	stream_wrap: streamWrap,
	uv,
	modules,
	url,
	url_pattern: urlPattern,
	encoding_binding: encodingBinding,
	util: utilBinding,
	fs,
	http_parser: httpParser,
	crypto: cryptoBinding,
};

function internalBinding(name: string): any {
	const binding = bindings[name];
	if (binding === undefined) {
		throw new Error(
			`internalBinding('${name}') is not implemented in this runtime`
		);
	}
	return binding;
}

export default internalBinding;
