import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import subagentExtension from "../../extensions/subagent/index.ts";
import { ProgressTracker } from "../../extensions/subagent/progress.ts";
import { formatTokens, renderAgentCall, renderAgentResult, summaryLine } from "../../extensions/subagent/render.ts";
import { createWorld, type World } from "./harness.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const lines = (c: { render(w: number): string[] }) => c.render(200).map((l) => l.trimEnd()).filter((l, i, a) => l || (i > 0 && i < a.length - 1));

describe("progress through the agent tool", () => {
	let w: World;
	before(async () => {
		w = await createWorld();
	});
	after(() => w.close());

	test("updates during a run carry the agent, description, tool-call count and token usage", async () => {
		const run = await w.run([{ description: "list files", prompt: "BASH echo hi" }]);
		const updates = run.updates(0);
		assert.ok(updates.length >= 2, "at least a tool call and a usage update");
		for (const d of updates) {
			assert.equal(d.agent, "general-purpose");
			assert.equal(d.description, "list files");
			assert.equal(d.status, "running");
		}
		const withCall = updates.find((d) => d.toolCalls === 1)!;
		assert.deepEqual(withCall.calls.map((c: any) => c.name), ["bash"]);
		assert.deepEqual(withCall.calls[0].args, { command: "echo hi" });
		assert.ok(updates.some((d) => d.tokens > 0), "token usage shows up");
		assert.ok(updates.every((d, i) => i === 0 || d.tokens >= updates[i - 1].tokens), "tokens never go down");
	});

	test("the final result's details carry the agent, model, usage and turn count", async () => {
		const { results } = await w.run([{ description: "two turns", prompt: "BASH echo hi" }]);
		const d = results[0].details;
		assert.equal(d.agent, "general-purpose");
		assert.equal(d.status, "done");
		assert.equal(d.model, "claude-sub/claude-sonnet-5-5");
		assert.equal(d.turns, 2);
		assert.equal(d.toolCalls, 1);
		assert.ok(d.usage.total > 0 && d.usage.input > 0 && d.usage.output > 0);
		assert.equal(d.tokens, d.usage.total);
	});

	test("the registered tool draws its call and result", () => {
		let tool: any;
		subagentExtension({ registerTool: (t: any) => (tool = t), on: () => {} } as any);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
	});
});

describe("progress tracker", () => {
	test("counts tool calls and sums assistant usage", () => {
		const t = new ProgressTracker("explore", "look");
		assert.equal(t.onEvent({ type: "turn_start" }), false);
		t.onEvent({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
		t.onEvent({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } } });
		t.onEvent({ type: "message_end", message: { role: "user" } });
		const s = t.snapshot();
		assert.equal(s.toolCalls, 1);
		assert.equal(s.tokens, 15);
		assert.equal(s.status, "running");
	});

	test("a status can be set, so a queued call can be shown", () => {
		const t = new ProgressTracker("explore", "look");
		t.setStatus("queued");
		assert.equal(t.snapshot().status, "queued");
	});
});

describe("renderers", () => {
	const running = { agent: "explore", description: "find the bug", status: "running", toolCalls: 2, tokens: 1234, calls: [{ name: "read", args: { path: "a.ts" } }, { name: "bash", args: { command: "ls -la" } }] } as const;
	const done = { ...running, status: "done", model: "m-1", turns: 3, usage: { input: 1000, output: 234, cacheRead: 0, cacheWrite: 0, total: 1234 } } as const;
	const content = [{ type: "text", text: "FINAL ANSWER" }];

	test("formats tokens", () => {
		assert.deepEqual([999, 1234, 12_345, 1_500_000].map(formatTokens), ["999", "1.2k", "12k", "1.5M"]);
	});

	test("call line shows the agent type and description", () => {
		assert.deepEqual(lines(renderAgentCall({ subagent_type: "explore", description: "find the bug" }, theme)), ["agent explore find the bug"]);
	});

	test("collapsed and running: one summary line plus the latest tool call", () => {
		const out = lines(renderAgentResult({ content, details: running }, { expanded: false, isPartial: true }, theme));
		assert.deepEqual(out, ["⏳ explore find the bug (2 tool calls, 1.2k tokens)", "  → bash ls -la"]);
	});

	test("collapsed and done: exactly one line, no final text", () => {
		const out = lines(renderAgentResult({ content, details: done }, { expanded: false, isPartial: false }, theme));
		assert.deepEqual(out, ["✓ explore find the bug (2 tool calls, 1.2k tokens)"]);
	});

	test("expanded and done: the tool calls and the final text", () => {
		const out = renderAgentResult({ content, details: done }, { expanded: true, isPartial: false }, theme).render(200).map((l) => l.trimEnd());
		const text = out.join("\n");
		assert.match(text, /✓ explore find the bug/);
		assert.match(text, /model m-1, 3 turns/);
		assert.match(text, /→ read a\.ts/);
		assert.match(text, /→ bash ls -la/);
		assert.match(text, /FINAL ANSWER/);
	});

	test("expanded and running: the tool calls so far, no final text", () => {
		const text = renderAgentResult({ content, details: running }, { expanded: true, isPartial: true }, theme).render(200).join("\n");
		assert.match(text, /→ read a\.ts/);
		assert.doesNotMatch(text, /FINAL ANSWER/);
	});

	test("a queued call says so", () => {
		assert.match(summaryLine({ ...running, status: "queued", toolCalls: 0, tokens: 0, calls: [] }, theme), /\(queued\)/);
	});

	test("a result without details falls back to its text", () => {
		assert.deepEqual(lines(renderAgentResult({ content, details: undefined }, { expanded: false, isPartial: false }, theme)), ["FINAL ANSWER"]);
	});
});
