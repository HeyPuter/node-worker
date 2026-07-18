import { codes } from './errors.js';

// For hiding Timeout instances on other internals (upstream internal/timers).
export const kTimeout = Symbol('timeout');

export function setUnrefTimeout(callback, after) {
	const handle = setTimeout(callback, after);
	handle?.unref?.();
	return handle;
}

export function getTimerDuration(msecs, name) {
	if (typeof msecs !== 'number' || Number.isNaN(msecs)) {
		throw new codes.ERR_INVALID_ARG_TYPE(name, 'number', msecs);
	}
	if (msecs < 0 || !Number.isFinite(msecs)) {
		throw new codes.ERR_OUT_OF_RANGE(name, 'a finite number >= 0', msecs);
	}
	return msecs;
}

export default {
	kTimeout,
	setUnrefTimeout,
	getTimerDuration,
};
