function unsupported(name) {
	return () => {
		throw new Error(`node:worker_threads.${name} is not supported in this runtime`);
	};
}

class Stub {
	constructor() {
		throw new Error('node:worker_threads class is not supported in this runtime');
	}
}

export const Worker = Stub;
export const MessageChannel = globalThis.MessageChannel;
export const MessagePort = globalThis.MessagePort;
export const BroadcastChannel = globalThis.BroadcastChannel;
export const isMainThread = false;
export const parentPort = null;
export const threadId = 0;
export const workerData = undefined;
export const resourceLimits = {};
export const SHARE_ENV = Symbol('SHARE_ENV');
export const moveMessagePortToContext = unsupported('moveMessagePortToContext');
export const receiveMessageOnPort = unsupported('receiveMessageOnPort');
export const setEnvironmentData = () => {};
export const getEnvironmentData = () => undefined;
export const markAsUntransferable = () => {};
export const isMarkedAsUntransferable = () => false;
export const markAsUncloneable = () => {};

export default {
	Worker,
	MessageChannel,
	MessagePort,
	BroadcastChannel,
	isMainThread,
	parentPort,
	threadId,
	workerData,
	resourceLimits,
	SHARE_ENV,
	moveMessagePortToContext,
	receiveMessageOnPort,
	setEnvironmentData,
	getEnvironmentData,
	markAsUntransferable,
	isMarkedAsUntransferable,
	markAsUncloneable,
};
