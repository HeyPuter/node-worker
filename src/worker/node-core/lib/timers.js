import {
  setTimeoutWrap,
  setIntervalWrap,
  setImmediateWrap,
  clearTimeoutWrap,
  clearIntervalWrap,
  clearImmediateWrap,
} from '../../node/timers';

const setTimeout = setTimeoutWrap;
const setInterval = setIntervalWrap;
const setImmediate = setImmediateWrap;
const clearTimeout = clearTimeoutWrap;
const clearInterval = clearIntervalWrap;
const clearImmediate = clearImmediateWrap;

export {
  clearImmediate,
  clearInterval,
  clearTimeout,
  setImmediate,
  setInterval,
  setTimeout,
};

export default {
  clearImmediate,
  clearInterval,
  clearTimeout,
  setImmediate,
  setInterval,
  setTimeout,
};
