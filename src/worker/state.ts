// Deliberately importless. Both `puter.ts` and the fs layer read this, so giving it
// a dependency pulls whatever that is into everything — importing `node/path` here
// to normalize `CWD` added a dozen cycle paths through the node subgraph. The
// normalization it was for lives in `normalizePath` instead, which anchors its
// resolve at "/" and so tolerates a relative value here.

export let PUTER_TOKEN: string | undefined;
export let CWD: string = "/";

export function setPuterToken(token: string) {
	PUTER_TOKEN = token;
}

export function setPuterCWD(cwd: string) {
	CWD = cwd;
}
