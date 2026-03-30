import { validateCwd } from "./node/fs";

export let PUTER_TOKEN: string | undefined;
export let CWD: string = "/";

export function setPuterToken(token: string) {
	PUTER_TOKEN = token;
}

export function setPuterCWD(cwd: string) {
	validateCwd(cwd);
	CWD = cwd;
}
