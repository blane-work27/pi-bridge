// Background subagents: the contract the control tools (`agent_send`, `agent_stop`, `agent_status`)
// run against, whichever backend hosts the subagent. The in-process backend implements it
// (in-process-backend.ts); the Herdr backend (herdr-backend.ts) implements the same interface.
import { randomInt } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createWorktree, finishWorktree, restoreWorktree, type Worktree, type WorktreeInfo } from "./worktrees.ts";

export type BackendName = "in-process" | "herdr";

/** `queued` waits for a concurrency slot, `idle` has finished its work and can be continued. */
export type AgentState = "queued" | "running" | "idle" | "stopped" | "failed";

/** Everything a backend needs to start one background subagent. The id is chosen by the registry. */
export interface LaunchSpec {
	id: string;
	agentType: string;
	description: string;
	cwd: string;
	prompt: string;
	appendSystemPrompt?: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	/** Start MCP servers for this subagent, and again whenever it is continued. */
	mcp?: boolean;
	ui: ExtensionUIContext | undefined;
	mode: "tui" | "rpc" | "json" | "print";
	projectTrusted: boolean;
	transcriptDir: string;
	parentSession?: string;
}

export interface AgentStatus {
	id: string;
	type: string;
	description: string;
	backend: BackendName;
	/** The Herdr terminal address, when the backend has one. */
	address?: string;
	state: AgentState;
	/** Assistant messages so far, across continuations. */
	turn: number;
	/** What it did last, and when (ISO time). */
	lastActivity: string;
	lastActivityAt: string;
	/** Absent when the backend cannot count them (a Herdr terminal). */
	toolCalls?: number;
	tokens?: number;
	transcript?: string;
	/** The failure, when `state` is `failed`. */
	error?: string;
	/** The subagent's git worktree, while it exists (isolation: "worktree"). */
	worktree?: WorktreeInfo;
}

/** What `onFinish` receives each time a run ends by itself (not when it is stopped). */
export interface FinishResult {
	ok: boolean;
	/** The final message, or the error message when `ok` is false. */
	text: string;
	transcript?: string;
	/** Set when the subagent's worktree was kept because it has commits or changes. */
	worktree?: WorktreeInfo;
	/** The worktree is still in use by a live terminal (Herdr), not kept for its changes. */
	worktreeInUse?: boolean;
	/** Herdr only: whether the subagent's terminal was ever opened. A run that failed before `hc run` succeeded has none. */
	terminalOpen?: boolean;
}

export interface AgentBackend {
	readonly name: BackendName;
	/** Launch and return once the subagent is started, not finished. */
	start(spec: LaunchSpec): Promise<{ address?: string }>;
	/** Steer a running subagent, or continue a finished one. Throws a clear error when neither is possible. */
	send(id: string, message: string): Promise<"steered" | "continued">;
	/** Abort and tear down. Idempotent. */
	stop(id: string): Promise<void>;
	status(id: string): AgentStatus;
	/** Bring what `status` reports up to date with the subagent itself, where it can drift (a Herdr terminal the user types into). */
	refresh?(id: string): Promise<void>;
	/** Call `cb` each time the subagent finishes a run by itself. */
	onFinish(id: string, cb: (result: FinishResult) => void): void;
}

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A short, human-typeable id fragment with no look-alike characters. The worktree branches `agent/<type>-<shortid>` reuse it. */
export function shortId(length = 5): string {
	let out = "";
	for (let i = 0; i < length; i++) out += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
	return out;
}

export function newAgentId(type: string, taken: (id: string) => boolean): string {
	const slug = type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	for (;;) {
		const id = `${slug}-${shortId()}`;
		if (!taken(id)) return id;
	}
}

interface Entry {
	backend: AgentBackend;
	/** isolation: "worktree": the subagent's worktree. `present` is false once finishing removed a clean one. */
	worktree?: { wt: Worktree; present: boolean };
}

/** The running (and finished) background subagents of one orchestrator, keyed by id, across backends. */
export class AgentRegistry {
	private readonly entries = new Map<string, Entry>();
	/** Per id: the tail of the send/stop calls so far, so they run one at a time. */
	private readonly chains = new Map<string, Promise<unknown>>();

	private chooseBackend: () => AgentBackend;
	private env?: NodeJS.ProcessEnv;

	constructor(chooseBackend: () => AgentBackend, options: { env?: NodeJS.ProcessEnv } = {}) {
		this.chooseBackend = chooseBackend;
		this.env = options.env;
	}

	/** A new session took over: later launches use its backends and environment. Running subagents are untouched. */
	rebind(chooseBackend: () => AgentBackend, options: { env?: NodeJS.ProcessEnv } = {}): void {
		this.chooseBackend = chooseBackend;
		this.env = options.env;
	}

	/** Start a subagent on the current backend. `onFinish` fires on every run that ends by itself. */
	async launch(
		spec: Omit<LaunchSpec, "id"> & { isolation?: "worktree" },
		onFinish: (id: string, r: FinishResult) => void,
	): Promise<{ id: string; backend: BackendName; address?: string; worktree?: WorktreeInfo }> {
		const backend = this.chooseBackend();
		const id = newAgentId(spec.agentType, (x) => this.entries.has(x));
		const { isolation, ...rest } = spec;
		const entry: Entry = { backend };
		let launchSpec: LaunchSpec = { ...rest, id };
		if (isolation === "worktree") {
			const wt = createWorktree({ cwd: spec.cwd, id, env: this.env });
			entry.worktree = { wt, present: true };
			launchSpec = { ...launchSpec, cwd: wt.cwd };
		}
		this.entries.set(id, entry);
		try {
			backend.onFinish(id, (r) => {
				// A Herdr terminal stays open in its worktree after the turn: judging (and removing) it waits for stop or shutdown.
				if (backend.name === "herdr" && entry.worktree && r.terminalOpen !== false) {
					const { path, branch } = entry.worktree.wt;
					onFinish(id, { ...r, worktree: { path, branch }, worktreeInUse: true });
					return;
				}
				const kept = this.finalize(entry);
				onFinish(id, kept ? { ...r, worktree: kept } : r);
			});
			const { address } = await backend.start(launchSpec);
			return { id, backend: backend.name, ...(address ? { address } : {}), ...(entry.worktree ? { worktree: { path: entry.worktree.wt.path, branch: entry.worktree.wt.branch } } : {}) };
		} catch (e) {
			this.entries.delete(id);
			if (entry.worktree) finishWorktree(entry.worktree.wt);
			throw e;
		}
	}

	/** A run ended: drop the worktree if it is clean and has no commits, and say where it is if it stays. */
	private finalize(entry: Entry): WorktreeInfo | undefined {
		if (!entry.worktree) return undefined;
		const done = finishWorktree(entry.worktree.wt);
		entry.worktree.present = !done.removed;
		return done.removed ? undefined : done.info;
	}

	private withWorktree(id: string, s: AgentStatus): AgentStatus {
		const w = this.entries.get(id)?.worktree;
		return w?.present ? { ...s, worktree: { path: w.wt.path, branch: w.wt.branch } } : s;
	}

	private get(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) {
			const known = [...this.entries.keys()];
			throw new Error(`Unknown subagent id "${id}". ${known.length ? `Known ids: ${known.join(", ")}` : "No background subagents have been started."}`);
		}
		return entry;
	}

	/** Run `fn` after every earlier send/stop of `id` has settled: a stop never interleaves with a send. */
	private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.chains.get(id) ?? Promise.resolve()).then(fn, fn);
		const tail = run.catch(() => {});
		this.chains.set(id, tail);
		void tail.then(() => {
			if (this.chains.get(id) === tail) this.chains.delete(id);
		});
		return run;
	}

	send(id: string, message: string): Promise<"steered" | "continued"> {
		const entry = this.get(id);
		return this.serial(id, async () => {
			// A clean worktree was removed when the subagent finished; a continuation needs it back. A stopped one stays gone.
			const { state } = entry.backend.status(id);
			if (entry.worktree && !entry.worktree.present && (state === "idle" || state === "failed")) {
				restoreWorktree(entry.worktree.wt);
				entry.worktree.present = true;
			}
			return entry.backend.send(id, message);
		});
	}

	stop(id: string): Promise<AgentStatus> {
		const entry = this.get(id);
		return this.serial(id, async () => {
			await entry.backend.stop(id);
			this.finalize(entry);
			return this.withWorktree(id, entry.backend.status(id));
		});
	}

	/** Ask the backends to refresh one subagent's status, or every one's, before `status` is read. Never fails. */
	async refresh(id?: string): Promise<void> {
		const entries = id !== undefined ? [this.get(id)].map((e) => [id, e] as const) : [...this.entries];
		await Promise.allSettled(entries.map(([k, e]) => e.backend.refresh?.(k)));
	}

	/** One subagent's status, or every one's. */
	status(id?: string): AgentStatus[] {
		if (id !== undefined) return [this.withWorktree(id, this.get(id).backend.status(id))];
		return [...this.entries].map(([k, e]) => this.withWorktree(k, e.backend.status(k)));
	}

	/** The orchestrator is exiting: stop everything, and forget it. */
	async stopAll(): Promise<void> {
		const ids = [...this.entries.keys()];
		await Promise.allSettled(ids.map((id) => this.entries.get(id)!.backend.stop(id)));
		// Clean worktrees go; one with commits or changes is never touched.
		for (const entry of this.entries.values()) this.finalize(entry);
		this.entries.clear();
	}
}
