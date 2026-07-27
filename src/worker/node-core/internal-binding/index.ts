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
import http2Binding from "./http2/index";
import traceEvents from "./trace_events";
import types from "./types";
import config from "./config";
import timers from "./timers";
import asyncContextFrame from "./async_context_frame";

const bindings: Record<string, any> = {
	zlib: zlibBinding,
	constants,
	stream_wrap: streamWrap,
	timers,
	// AsyncContextFrame (upstream internal/async_context_frame.js) destructures
	// get/setContinuationPreservedEmbedderData at load and uses them as
	// current()/set(). `--async-context-frame` is enabled (see lib/internal/
	// options.js), so these are live: they read/write the shared holder that the
	// await-transform and microtask patches also mutate. See ./async_context_frame.
	async_context_frame: asyncContextFrame,
	uv,
	modules,
	url,
	url_pattern: urlPattern,
	encoding_binding: encodingBinding,
	util: utilBinding,
	fs,
	http_parser: httpParser,
	crypto: cryptoBinding,
	http2: http2Binding,
	trace_events: traceEvents,
	types,
	config,
	// Destructured at load by internal/http2/core.js (stream_pipe, only used by
	// the server-side respondWithFile) and internal/js_stream_socket.js
	// (js_stream). The client path never constructs either — the patched core.js
	// removes the JSStreamSocket wrap — so these only need to not throw at import.
	stream_pipe: {
		StreamPipe: class StreamPipe {
			constructor() {
				throw new Error("StreamPipe is not available in this runtime");
			}
		},
	},
	js_stream: {
		JSStream: class JSStream {
			constructor() {
				throw new Error("JSStream is not available in this runtime");
			}
		},
	},
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
