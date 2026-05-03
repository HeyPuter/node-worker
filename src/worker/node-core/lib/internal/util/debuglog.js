function debuglog(_section, callback = undefined) {
  const logger = () => {};
  if (typeof callback === 'function') {
    queueMicrotask(() => callback(logger));
  }
  return logger;
}

export { debuglog };

export default {
  debuglog,
};
