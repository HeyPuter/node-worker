import { console_error } from "./console";
import { nodePrimordials as p } from "./node-primordials";

/** Public account information, without any credential. */
export interface PuterUser {
	username: string;
	uuid: string;
	email: string;
}

export let PUTER_USER: PuterUser = {
	username: "NOT_INITIALIZED",
	uuid: "NOT_INITIALIZED",
	email: "NOT_INITIALIZED",
};

export function setUserInfo(user: PuterUser): void {
	PUTER_USER = user;
	process.env.HOME = user.username === "anonymous" ? "/" : `/${user.username}`;
}

const requestCounts = new Map<string, number>();

/** Host filesystem replies carry API-call deltas. */
export function recordRequestStats(delta: Record<string, number>): void {
	const entries = p.ObjectEntries(delta);
	for (let i = 0; i < entries.length; i++) {
		const [path, count] = entries[i];
		p.MapPrototypeSet(
			requestCounts,
			path,
			(p.MapPrototypeGet(requestCounts, path) ?? 0) + count
		);
	}
}

export function resetRequestStats(): void {
	p.MapPrototypeClear(requestCounts);
}

export function apiStatsEnabled(): boolean {
	return !!process.env.NODE_WORKER_API_STATS;
}

export function reportRequestStats(fsOps?: Record<string, number>): void {
	const entries: [string, number][] = [];
	p.MapPrototypeForEach(requestCounts, (count, path) => {
		entries[entries.length] = [path, count];
	});
	const counts = p.ObjectFromEntries(
		p.ArrayPrototypeSort(entries, (a, b) => b[1] - a[1])
	);
	let total = 0;
	for (let i = 0; i < entries.length; i++) total += entries[i][1];
	console_error("[node-worker] api calls", counts);
	process.stderr.write(
		`[node-worker] api calls total=${total} ${p.JSONStringify(counts)}\n`
	);
	if (fsOps) {
		const values = p.ObjectValues(fsOps);
		let fsTotal = 0;
		for (let i = 0; i < values.length; i++) fsTotal += values[i];
		console_error("[node-worker] fs ops by mount", fsOps);
		process.stderr.write(
			`[node-worker] fs ops total=${fsTotal} ${p.JSONStringify(fsOps)}\n`
		);
	}
}
