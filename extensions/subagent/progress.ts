// Progress state of one `agent` call, built from the child session's events.
// The tool sends `snapshot()` as `details` on every update; renderers (render.ts) draw from it.

/** `queued` is for the concurrency cap: the child has not started yet. */
export type ProgressStatus = "queued" | "running" | "done" | "error";

export interface ToolCallInfo {
	name: string;
	args: unknown;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface AgentDetails {
	agent: string;
	description: string;
	status: ProgressStatus;
	toolCalls: number;
	/** Tokens used so far, all kinds. */
	tokens: number;
	/** The child's tool calls in order, capped at MAX_CALLS (the newest are kept). */
	calls: ToolCallInfo[];
	// Set once the child has finished.
	model?: string;
	usage?: Usage;
	turns?: number;
	/** The child's session file, for resuming it. */
	transcript?: string;
}

export const MAX_CALLS = 100;

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

export class ProgressTracker {
	private status: ProgressStatus = "running";
	private calls: ToolCallInfo[] = [];
	private toolCalls = 0;
	private usage = emptyUsage();

	private readonly agent: string;
	private readonly description: string;

	constructor(agent: string, description: string) {
		this.agent = agent;
		this.description = description;
	}

	setStatus(status: ProgressStatus): void {
		this.status = status;
	}

	/** Feed a child AgentSession event. Returns true when the progress changed. */
	onEvent(ev: any): boolean {
		if (ev.type === "tool_execution_start") {
			this.toolCalls++;
			this.calls.push({ name: ev.toolName, args: ev.args });
			if (this.calls.length > MAX_CALLS) this.calls.shift();
			return true;
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
			const u = ev.message.usage;
			this.usage.input += u.input ?? 0;
			this.usage.output += u.output ?? 0;
			this.usage.cacheRead += u.cacheRead ?? 0;
			this.usage.cacheWrite += u.cacheWrite ?? 0;
			this.usage.total += u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			return true;
		}
		return false;
	}

	snapshot(): AgentDetails {
		return {
			agent: this.agent,
			description: this.description,
			status: this.status,
			toolCalls: this.toolCalls,
			tokens: this.usage.total,
			calls: [...this.calls],
		};
	}

	/** The details of the finished call. `stats` is the child's own accounting, which wins over the event sum. */
	finish(outcome: { model: string; turns: number; usage: Usage }): AgentDetails {
		this.status = "done";
		return { ...this.snapshot(), tokens: outcome.usage.total, model: outcome.model, turns: outcome.turns, usage: outcome.usage };
	}
}
