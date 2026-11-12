// The control tools for background subagents. They run against the registry, so they behave the
// same whichever backend hosts the subagent.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { worktreeNote } from "./worktrees.ts";
import type { AgentRegistry, AgentStatus, FinishResult } from "./backend.ts";

const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

export function formatStatus(s: AgentStatus): string {
	const parts = [`${s.id} [${s.backend}${s.address ? ` ${s.address}` : ""}] ${s.state}`, `turn ${s.turn}`, `last activity: ${s.lastActivity} at ${s.lastActivityAt}`, ...(s.toolCalls !== undefined && s.tokens !== undefined ? [`${s.toolCalls} tool calls, ${s.tokens} tokens`] : [])];
	if (s.error) parts.push(`error: ${s.error}`);
	if (s.transcript) parts.push(`transcript ${s.transcript}`);
	if (s.worktree) parts.push(`worktree ${s.worktree.path} on branch ${s.worktree.branch}`);
	return `${parts[0]}: ${parts.slice(1).join("; ")}`;
}

/** The notice the orchestrator gets when a background subagent finishes. */
export function finishNotice(id: string, label: string, r: FinishResult): { customType: string; content: string; display: boolean; details: unknown } {
	const head = r.ok ? `Background subagent ${id} (${label}) finished.` : `Background subagent ${id} (${label}) failed.`;
	return {
		customType: "subagent-finished",
		content: `${head}\n\n${r.text}${worktreeNote(r.worktree, r.worktreeInUse)}`,
		display: true,
		details: { id, ok: r.ok, transcript: r.transcript, ...(r.worktree ? { worktree: r.worktree } : {}) },
	};
}

export function buildControlTools(registry: AgentRegistry) {
	const send = defineTool({
		name: "agent_send",
		label: "agent_send",
		description: "Send a message to a background subagent by id. A running subagent is steered: it sees the message after its current tool calls. A finished one is continued from its transcript, with its earlier turns, and you get a new notice when it finishes again.",
		parameters: Type.Object({
			id: Type.String({ description: "The subagent id from the background agent call." }),
			message: Type.String({ description: "What to tell it." }),
		}),
		async execute(_id, params) {
			const how = await registry.send(params.id, params.message);
			return text(how === "steered" ? `Message delivered to running subagent ${params.id}.` : `Subagent ${params.id} is continuing from its transcript; you will get a notice when it finishes.`, { id: params.id, how });
		},
	});
	const stop = defineTool({
		name: "agent_stop",
		label: "agent_stop",
		description: "Stop a background subagent by id: abort its work and tear it down, so nothing of it keeps running.",
		parameters: Type.Object({ id: Type.String({ description: "The subagent id." }) }),
		async execute(_id, params) {
			const s = await registry.stop(params.id);
			return text(`Stopped. ${formatStatus(s)}`, s);
		},
	});
	const status = defineTool({
		name: "agent_status",
		label: "agent_status",
		description: "Report background subagents: state (queued, running, idle, stopped, failed), turn, and last activity. Give an id for one, or omit it for all.",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "The subagent id. Omit for all." })) }),
		async execute(_id, params) {
			await registry.refresh(params.id);
			const all = registry.status(params.id);
			return text(all.length ? all.map(formatStatus).join("\n") : "No background subagents.", all);
		},
	});
	return [send, stop, status];
}
