// The in-process implementation of the background backend (backend.ts): a subagent is an
// AgentSession inside the orchestrator's pi. A run holds a concurrency slot from start to
// finish; when it ends the session is torn down, and `send` reopens its transcript to continue it.
import type { AgentBackend, AgentState, AgentStatus, FinishResult, LaunchSpec } from "./backend.ts";
import { withSlot } from "./concurrency.ts";
import { startChild, type ChildHandle } from "./in-process.ts";
import { ProgressTracker } from "./progress.ts";

interface Entry {
	spec: LaunchSpec;
	state: AgentState;
	progress: ProgressTracker;
	turn: number;
	lastActivity: string;
	lastActivityAt: number;
	transcript?: string;
	error?: string;
	/** Set while a run has its session open. */
	child?: ChildHandle;
	abort: AbortController;
	/** Settles when the current run, teardown included, is over. */
	settled: Promise<void>;
}

export class InProcessBackend implements AgentBackend {
	readonly name = "in-process" as const;
	private readonly entries = new Map<string, Entry>();
	private readonly callbacks = new Map<string, Array<(r: FinishResult) => void>>();

	async start(spec: LaunchSpec): Promise<{ address?: string }> {
		const entry: Entry = {
			spec,
			state: "queued",
			progress: new ProgressTracker(spec.agentType, spec.description),
			turn: 0,
			lastActivity: "launched",
			lastActivityAt: Date.now(),
			abort: new AbortController(),
			settled: Promise.resolve(),
		};
		this.entries.set(spec.id, entry);
		this.run(entry, spec.prompt);
		return {};
	}

	onFinish(id: string, cb: (r: FinishResult) => void): void {
		// The registry subscribes before `start`, so this is keyed by id, not by entry.
		this.callbacks.set(id, [...(this.callbacks.get(id) ?? []), cb]);
	}

	private entry(id: string): Entry {
		const e = this.entries.get(id);
		if (!e) throw new Error(`Unknown subagent id "${id}"`);
		return e;
	}

	async send(id: string, message: string): Promise<"steered" | "continued"> {
		const e = this.entry(id);
		switch (e.state) {
			case "running":
				if (!e.child) break;
				this.note(e, "message from the orchestrator");
				await e.child.steer(message);
				return "steered";
			case "queued":
				throw new Error(`Subagent ${id} is queued for a concurrency slot and has not started; send again once it is running.`);
			case "stopped":
				throw new Error(`Subagent ${id} was stopped; start a new one.`);
			case "failed":
			case "idle": {
				await e.settled;
				// Stopped, or already continued, while this waited.
				if (e.state === "stopped") throw new Error(`Subagent ${id} was stopped; start a new one.`);
				if (e.state !== "idle" && e.state !== "failed") throw new Error(`Subagent ${id} is already running again; send again in a moment.`);
				if (!e.transcript) throw new Error(`Subagent ${id} has no transcript to continue from.`);
				e.error = undefined;
				this.run(e, message, e.transcript);
				return "continued";
			}
		}
		throw new Error(`Subagent ${id} is finishing; send again in a moment.`);
	}

	async stop(id: string): Promise<void> {
		const e = this.entry(id);
		if (e.state === "stopped") return;
		e.state = "stopped";
		this.note(e, "stopped");
		e.abort.abort();
		await e.settled;
	}

	status(id: string): AgentStatus {
		const e = this.entry(id);
		const p = e.progress.snapshot();
		return {
			id,
			type: e.spec.agentType,
			description: e.spec.description,
			backend: this.name,
			state: e.state,
			turn: e.turn,
			lastActivity: e.lastActivity,
			lastActivityAt: new Date(e.lastActivityAt).toISOString(),
			toolCalls: p.toolCalls,
			tokens: p.tokens,
			...(e.transcript ? { transcript: e.transcript } : {}),
			...(e.error ? { error: e.error } : {}),
		};
	}

	private note(e: Entry, what: string) {
		e.lastActivity = what;
		e.lastActivityAt = Date.now();
	}

	/** One run: wait for a slot, open the session (a new one, or the transcript), prompt, tear down, report. */
	private run(e: Entry, prompt: string, resumeFile?: string): void {
		const ctl = new AbortController();
		e.abort = ctl;
		e.state = "queued";
		this.note(e, resumeFile ? "continuing" : "queued");
		const { spec } = e;
		e.settled = (async () => {
			let result: FinishResult;
			try {
				const text = await withSlot(ctl.signal, undefined, async () => {
					e.state = "running";
					this.note(e, "started");
					const child = await startChild({
						cwd: spec.cwd,
						label: `${spec.agentType}: ${spec.description}`,
						prompt,
						appendSystemPrompt: spec.appendSystemPrompt,
						model: spec.model,
						thinkingLevel: spec.thinkingLevel,
						tools: spec.tools,
						// On a continuation too: the MCP extension is not in the resumed session by itself.
						mcp: spec.mcp,
						ui: spec.ui,
						mode: spec.mode,
						projectTrusted: spec.projectTrusted,
						signal: ctl.signal,
						transcriptDir: spec.transcriptDir,
						parentSession: spec.parentSession,
						resumeFile,
						onEvent: (ev) => this.onEvent(e, ev),
					});
					e.child = child;
					e.transcript = child.sessionFile ?? e.transcript;
					try {
						const outcome = await child.prompt(prompt);
						e.transcript = outcome.transcript || e.transcript;
						return outcome.text;
					} finally {
						// First, so a `send` arriving now continues the transcript instead of steering a dying session.
						e.child = undefined;
						await child.teardown();
					}
				});
				result = { ok: true, text: text || "(the subagent returned no text)", transcript: e.transcript };
			} catch (err) {
				if (e.state === "stopped") return;
				const message = err instanceof Error ? err.message : String(err);
				e.error = message;
				e.state = "failed";
				this.note(e, "failed");
				result = { ok: false, text: message, transcript: e.transcript };
				this.finished(e, result);
				return;
			}
			if (e.state === "stopped") return;
			e.state = "idle";
			this.note(e, "finished");
			this.finished(e, result);
		})();
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

	private onEvent(e: Entry, ev: any) {
		e.progress.onEvent(ev);
		if (ev.type === "tool_execution_start") this.note(e, `tool ${ev.toolName}`);
		else if (ev.type === "message_end" && ev.message?.role === "assistant") {
			e.turn++;
			this.note(e, "assistant message");
		}
	}
}
