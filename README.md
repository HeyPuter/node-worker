# node-worker

nodejs-compatible runtime running transformed code in a Worker with node globals.

## Starting a worker

```js
import { NodeWorker } from "node-worker";
import workerURL from "node-worker/worker?url";
import swURL from "node-worker/sw?url";

const worker = await NodeWorker.create(workerURL, puterToken, "/project", { swURL });
await worker.import("/project/index.js", { argv: ["node", "/project/index.js"] });
```
