// `internalBinding('stream_wrap')` exposes the libuv handle wrappers used by
// `internal/webstreams/adapters.js`'s `newReadableStreamFromStreamBase` /
// `newWritableStreamFromStreamBase`. Those adapters are only invoked for
// libuv-backed handles (tcp_wrap, pipe_wrap, ...), which we don't expose. The
// classes are kept here as no-op shells so the upstream destructure at module
// top level doesn't crash; instantiating them throws because nobody should be
// creating libuv requests inside a worker.

class WriteWrap {
	constructor() {
		throw new Error(
			"libuv WriteWrap is not available in this runtime"
		);
	}
}

class ShutdownWrap {
	constructor() {
		throw new Error(
			"libuv ShutdownWrap is not available in this runtime"
		);
	}
}

// Indices into `streamBaseState`. The fields here just have to exist; the
// values follow upstream's `node_stream_base.h` ordering.
const kReadBytesOrError = 0;
const kArrayBufferOffset = 1;
const kBytesWritten = 2;
const kLastWriteWasAsync = 3;
const kStreamBaseStateFields = 4;

const streamBaseState = new Uint32Array(kStreamBaseStateFields);

export default {
	WriteWrap,
	ShutdownWrap,
	kReadBytesOrError,
	kArrayBufferOffset,
	kBytesWritten,
	kLastWriteWasAsync,
	streamBaseState,
};
