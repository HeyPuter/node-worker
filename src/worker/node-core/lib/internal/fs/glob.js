// Override of upstream `internal/fs/glob` to break a module-init cycle.
//
// The upstream file has `const { lstatSync, readdirSync } = require('fs');`
// at top level. Because `import { Glob } from "node-core:internal/fs/glob"`
// from node/fs/* is an *eager* ESM-from-CJS bridge in rollup, that top-level
// destructure runs while our `lib/fs.js` forwarder is still being initialized
// — `fs$3` (the default of node/fs/index.ts) is undefined at that point and
// every read off it throws. Upstream Node side-steps this with
// `getLazy(() => require('internal/fs/glob').Glob)`, but ESM imports in our
// rollup-bundled worker can't be deferred that way.
//
// Our `node/fs/{index,sync,promises-sync}.ts` only reference `Glob` inside
// function bodies, so the *import* doesn't need a working implementation —
// just the symbols. We export throwing stubs; if anything actually invokes
// `fs.glob` / `fs.globSync` / `fs.promises.glob`, the throw kicks in. That's
// acceptable: real consumers reach for `tinyglobby` and friends instead.
//
// Drop this override and reuse upstream once we have a way to lazily resolve
// CJS imports across the ESM bridge.

class Glob {
	constructor() {
		throw new Error('fs.glob is not implemented in this runtime');
	}
}

function matchGlobPattern() {
	throw new Error('matchGlobPattern is not implemented in this runtime');
}

export { Glob, matchGlobPattern };
export default { Glob, matchGlobPattern };
