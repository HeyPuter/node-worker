# roadmap

- [x] Get basic node:fs implementation working
- [x] Implement resolving `require`/esm `import` modules and executing them
- [x] Implement most common node modules (process, stream, readline)
- [x] Implement node:net with puter.peer
    - [ ] Make sure node:net integration works with browser.js
    - [ ] Make sure node:net works with `puter.net.fetch` ?
- [x] Implement node http APIs
    - [ ] Implement http2
    - [ ] Implement https
- [ ] Implement tls APIs
- [ ] Implement all node APIs

## demo targets
- [x] ChatGPT demos for things like net, http, readline
- [ ] some CLI app - pi agent?
- [ ] Vite
    - [x] Get vite code executing
    - [ ] Rollup native module fix
    - [ ] ...

## frontend
- [x] Implement CLI harness around node-worker API
- [x] Implement basic `npm install` replacement with optimizations for Puter
- [ ] Allow running node_modules package binaries / npx binaries
