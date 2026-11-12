// Renderers for the `agent` tool call and its progress/result, drawn from AgentDetails.
import { Text } from "@earendil-works/pi-tui";
import type { AgentDetails, ToolCallInfo } from "./progress.ts";

/** The slice of pi's Theme the renderers use, so tests can pass a plain stub. */
export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function preview(value: unknown, max: number): string {
	const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** `bash ls -la`: the first argument value is the useful part for most tools. */
export function formatToolCall(call: ToolCallInfo): string {
	const args: any = call.args;
	if (args && typeof args === "object") {
		const first = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? Object.values(args)[0];
		if (first !== undefined) return `${call.name} ${preview(first, 70)}`;
	}
	return call.name;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The one collapsed line: agent type, description, tool-call count, tokens. */
export function summaryLine(d: AgentDetails, theme: RenderTheme): string {
	const mark = d.status === "done" ? theme.fg("success", "✓") : d.status === "error" ? theme.fg("error", "✗") : d.status === "queued" ? theme.fg("muted", "…") : theme.fg("warning", "⏳");
	const stats = d.status === "queued" ? "queued" : `${plural(d.toolCalls, "tool call")}, ${formatTokens(d.tokens)} tokens`;
	return `${mark} ${theme.fg("accent", d.agent)} ${theme.fg("dim", d.description)} ${theme.fg("muted", `(${stats})`)}`;
}

export function renderAgentCall(args: { subagent_type?: string; description?: string }, theme: RenderTheme): Text {
	return new Text(theme.fg("toolTitle", theme.bold("agent ")) + theme.fg("accent", args.subagent_type ?? "...") + theme.fg("dim", ` ${args.description ?? ""}`), 0, 0);
}

export function renderAgentResult(result: { content: { type: string; text?: string }[]; details?: unknown }, opts: { expanded: boolean; isPartial: boolean }, theme: RenderTheme): Text {
	const d = result.details as AgentDetails | undefined;
	const finalText = result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
	if (!d || typeof d !== "object" || !("agent" in d)) return new Text(finalText || "(no output)", 0, 0);

	let out = summaryLine(d, theme);
	if (!opts.expanded) {
		// While it runs, show what the child is doing now.
		const latest = d.calls.at(-1);
		if (opts.isPartial && latest) out += `\n  ${theme.fg("muted", "→ ")}${theme.fg("dim", formatToolCall(latest))}`;
		return new Text(out, 0, 0);
	}
	if (d.model) out += `\n${theme.fg("muted", `model ${d.model}, ${plural(d.turns ?? 0, "turn")}`)}`;
	const skipped = d.toolCalls - d.calls.length;
	if (skipped > 0) out += `\n${theme.fg("muted", `... ${skipped} earlier tool calls`)}`;
	for (const call of d.calls) out += `\n${theme.fg("muted", "→ ")}${theme.fg("dim", formatToolCall(call))}`;
	if (!opts.isPartial && finalText) out += `\n\n${theme.fg("toolOutput", finalText)}`;
	return new Text(out, 0, 0);
}
