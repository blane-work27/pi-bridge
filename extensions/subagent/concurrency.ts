// Concurrency cap for subagents: at most SUBAGENT_CONCURRENCY run at once, the rest queue.
// The semaphore follows the one in the jank extension (extensions/jank/runner.ts), extended
// with abort-while-queued. It lives on globalThis so every copy of this module in the process
// (pi may load an extension more than once) and both backends share one count.

export const DEFAULT_CONCURRENCY = 8;
const KEY = Symbol.for("pi-bridge.subagent.semaphore");

/** The cap, read on every acquire so a changed SUBAGENT_CONCURRENCY applies to the next subagent. */
export function concurrencyCap(env: NodeJS.ProcessEnv = process.env): number {
	const n = Math.floor(Number(env.SUBAGENT_CONCURRENCY));
	return Number.isFinite(n) && n >= 1 ? n : DEFAULT_CONCURRENCY;
}

interface Waiter {
	grant: () => void;
}

class Semaphore {
	active = 0;
	queue: Waiter[] = [];

	/** Resolves with a release function once a slot is free. Rejects, leaving the queue, if the signal aborts first. */
	acquire(limit: number, signal: AbortSignal | undefined, onQueued?: () => void): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("Subagent aborted before it started"));
		if (this.active < limit && this.queue.length === 0) return Promise.resolve(this.take());
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				grant: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve(this.take());
				},
			};
			const onAbort = () => {
				const i = this.queue.indexOf(waiter);
				if (i >= 0) this.queue.splice(i, 1);
				reject(new Error("Subagent aborted before it started"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(waiter);
			onQueued?.();
		});
	}

	private take(): () => void {
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.queue.shift()?.grant();
		};
	}
}

function semaphore(): Semaphore {
	const g = globalThis as any;
	return (g[KEY] ??= new Semaphore());
}

/** Run `fn` once a slot is free. `onQueued` fires if the caller has to wait. */
export async function withSlot<T>(signal: AbortSignal | undefined, onQueued: (() => void) | undefined, fn: () => Promise<T>): Promise<T> {
	const release = await semaphore().acquire(concurrencyCap(), signal, onQueued);
	try {
		return await fn();
	} finally {
		release();
	}
}
