// The Herdr implementation of the background backend (backend.ts): a subagent is an interactive
// pi-bridge in its own Herdr terminal, a child of the orchestrator's terminal. The user can watch
// it, answer its approvals and type into it. All `hc` calls go through `HerdrTerminals`.
//
// A run holds a concurrency slot from launch (or send) until Herdr reports the turn finished.
// The terminal then stays open, so `send` continues the same session, until `stop` or the
// orchestrator exits.
import { existsSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentBackend, AgentState, AgentStatus, FinishResult, LaunchSpec } from "./backend.ts";
import { withSlot } from "./concurrency.ts";
import { NEVER_INHERITED } from "./in-process.ts";
import { type HerdrTerminals } from "./herdr-terminals.ts";
import { lastAssistantMessage } from "./transcripts.ts";

/** The environment variable the parent sets on a Herdr child: its copy of the extension registers nothing. */
export const NO_NESTING_ENV = "PI_SUBAGENT";

/** Inside a Herdr terminal. `HC_SCOPE` is not a signal: `hc exec` sets it outside any terminal. */
export function herdrTerminalId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.HC_TERMINAL_ID || undefined;
}

export function insideHerdrChild(env: NodeJS.ProcessEnv = process.env): boolean {
	return !!env[NO_NESTING_ENV];
}

/** The file pi itself appends when no `--append-system-prompt` is given: the trusted project's `.pi/APPEND_SYSTEM.md`, else the agent dir's. */
function discoveredAppendFile(cwd: string, projectTrusted: boolean): string | undefined {
	const project = join(cwd, ".pi", "APPEND_SYSTEM.md");
	if (projectTrusted && existsSync(project)) return project;
	const global = join(getAgentDir(), "APPEND_SYSTEM.md");
	return existsSync(global) ? global : undefined;
}

interface Entry {
	spec: LaunchSpec;
	state: AgentState;
	turn: number;
	/** Turns at or before this one were already reported; finishing needs a later turn. */
	reportedTurn: number;
	lastActivity: string;
	lastActivityAt: number;
	transcript: string;
	address?: string;
	error?: string;
	/** The terminal exists (hc run succeeded). */
	launched: boolean;
	abort: AbortController;
	settled: Promise<void>;
}

export interface HerdrBackendOptions {
	terminals: HerdrTerminals;
	/** The orchestrator's terminal, the parent of every child. Read per launch. */
	parent: () => string | undefined;
	/** The pi launcher a child runs. Default `pi-bridge`. */
	piBin?: string;
}

export class HerdrBackend implements AgentBackend {
	readonly name = "herdr" as const;
	private readonly entries = new Map<string, Entry>();
	private readonly callbacks = new Map<string, Array<(r: FinishResult) => void>>();
	private readonly terminals: HerdrTerminals;
	private readonly parent: () => string | undefined;
	private readonly piBin: string;

	constructor(o: HerdrBackendOptions) {
		this.terminals = o.terminals;
		this.parent = o.parent;
		this.piBin = o.piBin ?? "pi-bridge";
	}

	onFinish(id: string, cb: (r: FinishResult) => void): void {
		this.callbacks.set(id, [...(this.callbacks.get(id) ?? []), cb]);
	}

	private entry(id: string): Entry {
		const e = this.entries.get(id);
		if (!e) throw new Error(`Unknown subagent id "${id}"`);
		return e;
	}

	/** The `hc` terminal name is the subagent id. */
	private argv(spec: LaunchSpec, transcript: string): string[] {
		const args = ["env", `${NO_NESTING_ENV}=1`, this.piBin, "--model", `${spec.model.provider}/${spec.model.id}:${spec.thinkingLevel}`];
		args.push(...(spec.tools.length ? ["--tools", spec.tools.join(",")] : ["--no-tools"]));
		args.push("--exclude-tools", NEVER_INHERITED.join(","));
		if (!spec.mcp) args.push("--no-mcp");
		if (spec.appendSystemPrompt) {
			// An explicit append source stops pi discovering APPEND_SYSTEM.md (the pi-bridge addendum): pass that file too, first.
			const addendum = discoveredAppendFile(spec.cwd, spec.projectTrusted);
			if (addendum) args.push("--append-system-prompt", addendum);
			args.push("--append-system-prompt", spec.appendSystemPrompt);
		}
		args.push("--session", transcript);
		// A prompt that starts with "-" would be read as a flag, one that starts with "@" as a file to include.
		args.push(/^[-@]/.test(spec.prompt) ? `\n${spec.prompt}` : spec.prompt);
		return args;
	}

	async start(spec: LaunchSpec): Promise<{ address?: string }> {
		const parent = this.parent();
		if (!parent) throw new Error("Not inside a Herdr terminal (HC_TERMINAL_ID is not set)");
		mkdirSync(spec.transcriptDir, { recursive: true });
		const e: Entry = {
			spec,
			state: "queued",
			turn: 0,
			reportedTurn: 0,
			lastActivity: "queued",
			lastActivityAt: Date.now(),
			transcript: join(spec.transcriptDir, `${spec.id}.jsonl`),
			launched: false,
			abort: new AbortController(),
			settled: Promise.resolve(),
		};
		this.entries.set(spec.id, e);
		try {
			return await this.begin(e, async () => {
				const { address } = await this.terminals.run({ name: spec.id, parent, cwd: spec.cwd, argv: this.argv(spec, e.transcript) });
				e.address = address;
				e.launched = true;
				// Stopped while `hc run` was in flight: `stop` could not kill a terminal that did not exist yet.
				if (e.state === "stopped") {
					await this.terminals.kill(this.target(e)).catch(() => {});
					throw new Error("The subagent was stopped before its terminal started");
				}
			}, "stopped");
		} catch (err) {
			// A launch that failed is not a background subagent: the call itself fails.
			this.entries.delete(spec.id);
			throw err;
		}
	}

	/**
	 * Run `act` (the launch, or a send into the open terminal) in a run of its own. Resolves once `act` is done,
	 * or at once when the run has to queue for a slot; rejects, putting the subagent back in `stateOnFailure`, when `act` fails.
	 */
	private begin(e: Entry, act: () => Promise<void>, stateOnFailure: AgentState): Promise<{ address?: string }> {
		return new Promise((resolve, reject) => {
			let answered = false;
			this.run(e, {
				launch: async () => {
					try {
						await act();
						answered = true;
						resolve({ address: e.address });
					} catch (err) {
						if (answered) throw err;
						answered = true;
						e.state = stateOnFailure;
						reject(err);
						return false;
					}
				},
				onQueued: () => {
					answered = true;
					resolve({});
				},
			});
		});
	}

	async send(id: string, message: string): Promise<"steered" | "continued"> {
		const e = this.entry(id);
		switch (e.state) {
			case "running":
				this.note(e, "message from the orchestrator");
				await this.terminals.send(this.target(e), message);
				return "steered";
			case "queued":
				throw new Error(`Subagent ${id} is queued for a concurrency slot and has not started; send again once it is running.`);
			case "stopped":
				throw new Error(`Subagent ${id} was stopped; start a new one.`);
			case "failed":
			case "idle": {
				await e.settled;
				if (e.state === "stopped") throw new Error(`Subagent ${id} was stopped; start a new one.`);
				if (e.state !== "idle" && e.state !== "failed") throw new Error(`Subagent ${id} is already running again; send again in a moment.`);
				if (!e.launched) throw new Error(`Subagent ${id} never started; start a new one.`);
				e.error = undefined;
				await this.begin(
					e,
					async () => {
						// The user may have driven the terminal to a later turn since the last report: only a turn after this one answers the message.
						const now = await this.terminals.get(this.target(e));
						e.reportedTurn = Math.max(e.reportedTurn, now.turn);
						await this.terminals.send(this.target(e), message);
					},
					e.state,
				);
				return "continued";
			}
		}
	}

	async stop(id: string): Promise<void> {
		const e = this.entry(id);
		if (e.state === "stopped") return;
		e.state = "stopped";
		this.note(e, "stopped");
		e.abort.abort();
		if (e.launched) {
			try {
				await this.terminals.kill(this.target(e));
			} catch {
				// The terminal is already gone (the user closed it): nothing left to stop.
			}
		}
		await e.settled;
	}

	status(id: string): AgentStatus {
		const e = this.entry(id);
		return {
			id,
			type: e.spec.agentType,
			description: e.spec.description,
			backend: this.name,
			...(e.address ? { address: e.address } : {}),
			state: e.state,
			turn: e.turn,
			lastActivity: e.lastActivity,
			lastActivityAt: new Date(e.lastActivityAt).toISOString(),
			transcript: e.transcript,
			...(e.error ? { error: e.error } : {}),
		};
	}

	async refresh(id: string): Promise<void> {
		const e = this.entry(id);
		if (!e.launched || e.state === "stopped" || e.state === "queued") return;
		try {
			const s = await this.terminals.get(this.target(e));
			// Turns only count up; keep the last-activity text.
			e.turn = Math.max(e.turn, s.turn);
		} catch {
			// The terminal is unreachable: report what we last knew.
		}
	}

	private target(e: Entry): string {
		return e.spec.id;
	}

	private note(e: Entry, what: string) {
		e.lastActivity = what;
		e.lastActivityAt = Date.now();
	}

	/** One run: wait for a slot, launch (or send), watch the terminal until its turn finishes, report. */
	private run(e: Entry, step: { launch: () => Promise<boolean | void>; onQueued?: () => void }): void {
		const ctl = new AbortController();
		e.abort = ctl;
		e.state = "queued";
		this.note(e, "queued");
		e.settled = (async () => {
			let result: FinishResult;
			let notStarted = false;
			try {
				await withSlot(ctl.signal, step.onQueued, async () => {
					e.state = "running";
					this.note(e, "started");
					if ((await step.launch()) === false) {
						notStarted = true;
						return;
					}
					await this.watch(e, ctl.signal);
				});
				if (notStarted || e.state === "stopped") return;
				result = this.result(e);
				e.state = "idle";
				this.note(e, "finished");
			} catch (err) {
				if (e.state === "stopped") return;
				const message = err instanceof Error ? err.message : String(err);
				e.error = message;
				e.state = "failed";
				this.note(e, "failed");
				result = { ok: false, text: message, transcript: e.transcript, terminalOpen: e.launched };
			}
			this.finished(e, result);
		})();
	}

	/** Loop `hc wait` until the terminal's turn is past the last reported one and Herdr says `done`. */
	private async watch(e: Entry, signal: AbortSignal): Promise<void> {
		let previous = "";
		for (;;) {
			const s = await this.terminals.wait(this.target(e), signal);
			e.turn = s.turn;
			if (s.status === "done" && s.turn > e.reportedTurn) {
				e.reportedTurn = s.turn;
				return;
			}
			if (s.ended) throw new Error(`The subagent's terminal ended${s.reason ? ` (${s.reason})` : ""} before it finished`);
			if (s.status === "error") throw new Error("The subagent's terminal reported an error");
			this.note(e, s.status === "blocked" ? "waiting for an approval in its terminal" : s.status);
			// `hc wait` on a terminal that has not moved on (just after a send) returns at once: back off instead of spinning.
			const key = `${s.status}:${s.turn}`;
			if (key === previous) await sleep(250, undefined, { signal });
			previous = key;
		}
	}

	private result(e: Entry): FinishResult {
		const last = lastAssistantMessage(e.transcript);
		if (last?.error) return { ok: false, text: last.error, transcript: e.transcript };
		return { ok: true, text: last?.text || "(the subagent returned no text)", transcript: e.transcript };
	}

	private finished(e: Entry, result: FinishResult) {
		for (const cb of this.callbacks.get(e.spec.id) ?? []) {
			try {
				cb(result);
			} catch {
				// A broken notice must not break the subagent's own bookkeeping.
			}
		}
	}
}
