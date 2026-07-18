// Minimal `internal/bootstrap/realm` override. Upstream this is the builtin
// module loader/registry; the only surface reached from the modules we load
// (via `internal/util/inspect.js`) is `BuiltinModule.exists(id)`, used purely to
// annotate `node:` frames when formatting error stacks. Reporting "not a
// builtin" just skips that cosmetic annotation — everything else is unaffected.

const BuiltinModule = {
  exists(_id) {
    return false;
  },
};

export { BuiltinModule };

export default { BuiltinModule };
