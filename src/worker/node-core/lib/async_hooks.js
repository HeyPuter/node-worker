class AsyncResource {
  constructor(type = 'AsyncResource') {
    this.type = type;
    this._asyncId = AsyncResource._nextId++;
  }

  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  }

  emitDestroy() {}

  asyncId() {
    return this._asyncId;
  }

  triggerAsyncId() {
    return 0;
  }
}

AsyncResource._nextId = 1;

export { AsyncResource };

export default {
  AsyncResource,
};
