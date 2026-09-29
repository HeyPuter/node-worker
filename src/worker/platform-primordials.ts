// Browser APIs that runtime plumbing must keep even when a program replaces its
// globals or prototype methods. This leaf is evaluated by bootstrap.ts first.
const g = globalThis;
const call = Function.prototype.call;
const bind = Function.prototype.bind;
const uncurry = bind.bind(call) as <T extends (...args: any[]) => any>(
	fn: T
) => (self: unknown, ...args: Parameters<T>) => ReturnType<T>;

export const platformPrimordials = Object.freeze({
	fetch: g.fetch.bind(g),
	WebSocket: g.WebSocket,
	XMLHttpRequest: g.XMLHttpRequest,
	MessageChannel: g.MessageChannel,
	MessagePort: g.MessagePort,
	BroadcastChannel: g.BroadcastChannel,
	ReadableStream: g.ReadableStream,
	WritableStream: g.WritableStream,
	TransformStream: g.TransformStream,
	ArrayBuffer: g.ArrayBuffer,
	Uint8Array: g.Uint8Array,
	Blob: g.Blob,
	Event: g.Event,
	MessageEvent: g.MessageEvent,
	CloseEvent: g.CloseEvent,
	DOMException: g.DOMException,
	Error: g.Error,
	TypeError: g.TypeError,
	String: g.String,
	Promise: g.Promise,
	Set: g.Set,
	Request: g.Request,
	Response: g.Response,
	responseBody: uncurry(
		Object.getOwnPropertyDescriptor(Response.prototype, "body")!.get!
	) as (response: Response) => ReadableStream<Uint8Array<ArrayBuffer>> | null,
	responseConsumers: Object.freeze([
		["arrayBuffer", Response.prototype.arrayBuffer],
		["blob", Response.prototype.blob],
		["bytes", (Response.prototype as Response & { bytes?: Function }).bytes],
		["formData", Response.prototype.formData],
		["json", Response.prototype.json],
		["text", Response.prototype.text],
	] as const),
	Headers: g.Headers,
	URL: g.URL,
	TextEncoder: g.TextEncoder,
	TextDecoder: g.TextDecoder,
	textDecoderDecode: uncurry(TextDecoder.prototype.decode),
	textEncoderEncode: uncurry(TextEncoder.prototype.encode),
	arrayBufferIsView: ArrayBuffer.isView.bind(ArrayBuffer),
	u8Set: uncurry(Uint8Array.prototype.set),
	u8Subarray: uncurry(Uint8Array.prototype.subarray) as <
		T extends ArrayBufferLike,
	>(
		array: Uint8Array<T>,
		begin?: number,
		end?: number
	) => Uint8Array<T>,
	blobArrayBuffer: uncurry(Blob.prototype.arrayBuffer),
	eventTargetDispatchEvent: uncurry(EventTarget.prototype.dispatchEvent),
	eventTargetAddEventListener: uncurry(EventTarget.prototype.addEventListener),
	eventTargetRemoveEventListener: uncurry(
		EventTarget.prototype.removeEventListener
	),
	queueMicrotask: g.queueMicrotask.bind(g),
	promiseResolve: Promise.resolve.bind(Promise),
	promiseAllSettled: Promise.allSettled.bind(Promise),
	promiseAll: Promise.all.bind(Promise),
	promiseThen: uncurry(Promise.prototype.then) as <T, R1 = T, R2 = never>(
		promise: Promise<T>,
		onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
		onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
	) => Promise<R1 | R2>,
	promiseCatch: uncurry(Promise.prototype.catch) as <T, R = never>(
		promise: Promise<T>,
		onrejected: (reason: any) => R | PromiseLike<R>
	) => Promise<T | R>,
	reflectApply: Reflect.apply.bind(Reflect),
	setHas: uncurry(Set.prototype.has),
	messagePortPostMessage: uncurry(MessagePort.prototype.postMessage) as (
		port: MessagePort,
		message: unknown,
		transfer?: Transferable[]
	) => void,
	messagePortStart: uncurry(MessagePort.prototype.start),
	messagePortClose: uncurry(MessagePort.prototype.close),
	readableGetReader: uncurry(ReadableStream.prototype.getReader),
	readableCancel: uncurry(ReadableStream.prototype.cancel),
	readerRead: uncurry(ReadableStreamDefaultReader.prototype.read),
	readerCancel: uncurry(ReadableStreamDefaultReader.prototype.cancel),
	writableGetWriter: uncurry(WritableStream.prototype.getWriter),
	writableAbort: uncurry(WritableStream.prototype.abort),
	writerWrite: uncurry(WritableStreamDefaultWriter.prototype.write),
	writerClose: uncurry(WritableStreamDefaultWriter.prototype.close),
	writerAbort: uncurry(WritableStreamDefaultWriter.prototype.abort),
	writerReady: uncurry(
		Object.getOwnPropertyDescriptor(
			WritableStreamDefaultWriter.prototype,
			"ready"
		)!.get!
	) as (writer: WritableStreamDefaultWriter) => Promise<void>,
	writerReleaseLock: uncurry(WritableStreamDefaultWriter.prototype.releaseLock),
	headersEntries: uncurry(Headers.prototype.entries),
	headersHas: uncurry(Headers.prototype.has),
	headersGet: uncurry(Headers.prototype.get),
	headersSet: uncurry(Headers.prototype.set),
});
