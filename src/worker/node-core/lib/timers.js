function setImmediateShim(callback, ...args) {
  return setTimeout(callback, 0, ...args);
}

function clearImmediateShim(handle) {
  clearTimeout(handle);
}

const clearImmediate = clearImmediateShim;
const clearIntervalShim = clearInterval;
const clearTimeoutShim = clearTimeout;
const setImmediate = setImmediateShim;
const setIntervalShim = setInterval;
const setTimeoutShim = setTimeout;

export {
  clearImmediate,
  clearIntervalShim as clearInterval,
  clearTimeoutShim as clearTimeout,
  setImmediate,
  setIntervalShim as setInterval,
  setTimeoutShim as setTimeout,
};

export default {
  clearImmediate,
  clearInterval: clearIntervalShim,
  clearTimeout: clearTimeoutShim,
  setImmediate,
  setInterval: setIntervalShim,
  setTimeout: setTimeoutShim,
};
