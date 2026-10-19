/**
 * A Puter token that can change while the things built on it keep running.
 *
 * Godmode apps run on a token the desktop renews while the window is open, and a renewal can
 * hand over a different one. Everything that talks to Puter on a worker's behalf — the Drive,
 * the relay, the change feed, and every sibling worker — holds this object rather than the
 * string, so one `set` moves all of them at once without anyone having to track who they are.
 */
export class PuterCredential {
	#token: string;
	#listeners = new Set<(token: string, previous: string) => void>();

	constructor(token: string) {
		this.#token = token.trim();
	}

	get token(): string {
		return this.#token;
	}

	/**
	 * Replace the token.
	 *
	 * An empty one is ignored rather than taken as a sign-out: the SDK clears its token while a
	 * reauth is in flight and sets the replacement after, and going anonymous in between would
	 * drop the Drive out from under a running program.
	 */
	set(token: string): void {
		const next = token.trim();
		if (!next || next === this.#token) return;
		const previous = this.#token;
		this.#token = next;
		for (const fn of [...this.#listeners]) {
			try {
				fn(next, previous);
			} catch (err) {
				console.error("[node-worker] credential listener failed", err);
			}
		}
	}

	/** Called after every change with the new token and the one it replaced. */
	onChange(fn: (token: string, previous: string) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}
}

/** A credential for `token`, or the one passed in; undefined when there is no token at all. */
export function toCredential(
	token: string | PuterCredential | undefined
): PuterCredential | undefined {
	if (token instanceof PuterCredential) return token.token ? token : undefined;
	return token?.trim() ? new PuterCredential(token) : undefined;
}
