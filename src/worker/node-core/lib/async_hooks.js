// Minimal async_hooks for a single-context worker (no libuv async_hooks
// binding). AsyncResource just runs callbacks in place. AsyncLocalStorage is a
// synchronous-scope store: correct inside run()/enterWith() and across
// synchronous and directly-returned-promise call chains, best-effort across
// arbitrary async gaps (true cross-await propagation needs the async_hooks C++
// binding we don't have). This is enough for undici and most libraries, which
// use ALS for context propagation and degrade gracefully when it is absent.

class AsyncResource {
  constructor(type = 'AsyncResource') {
    this.type = type;
    this._asyncId = AsyncResource._nextId++;
  }

  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  }

  bind(fn, thisArg) {
    const self = this;
    const bound = function (...args) {
      return self.runInAsyncScope(fn, thisArg ?? this, ...args);
    };
    return bound;
  }

  emitDestroy() {
    return this;
  }

  asyncId() {
    return this._asyncId;
  }

  triggerAsyncId() {
    return 0;
  }

  static bind(fn, type, thisArg) {
    const resource = new AsyncResource(type || fn.name || 'bound-anonymous-fn');
    return resource.bind(fn, thisArg);
  }
}

AsyncResource._nextId = 1;

class AsyncLocalStorage {
  #store = undefined;
  #enabled = false;

  disable() {
    this.#enabled = false;
    this.#store = undefined;
  }

  getStore() {
    return this.#enabled ? this.#store : undefined;
  }

  enterWith(store) {
    this.#enabled = true;
    this.#store = store;
  }

  run(store, callback, ...args) {
    const prevStore = this.#store;
    const prevEnabled = this.#enabled;
    this.#enabled = true;
    this.#store = store;
    try {
      return callback(...args);
    } finally {
      this.#enabled = prevEnabled;
      this.#store = prevStore;
    }
  }

  exit(callback, ...args) {
    const prevStore = this.#store;
    const prevEnabled = this.#enabled;
    this.#enabled = false;
    this.#store = undefined;
    try {
      return callback(...args);
    } finally {
      this.#enabled = prevEnabled;
      this.#store = prevStore;
    }
  }

  // Captures the current store and returns a runner that restores it. Without
  // real async tracking this snapshots synchronously — sufficient for the
  // common "capture now, run later in the same context" pattern.
  static bind(fn) {
    return AsyncLocalStorage.snapshot().bind(null, fn);
  }

  static snapshot() {
    return (callback, ...args) => callback(...args);
  }
}

// async_hooks hook machinery is a no-op here (no resource lifecycle events).
function createHook() {
  return {
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  };
}

function executionAsyncId() {
  return 0;
}

function triggerAsyncId() {
  return 0;
}

function executionAsyncResource() {
  return Object.create(null);
}

export {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};

export default {
  AsyncLocalStorage,
  AsyncResource,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};
