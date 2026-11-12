// MCP only when the subagent needs it. Teardown after finish, error and abort is in subagent.test.ts.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { wantsMcp } from "../../extensions/subagent/definitions.ts";
import { createWorld, waitFor, type World } from "./harness.ts";

const MCP_AGENT = "---\nname: mcp-agent\ndescription: reads through MCP\ntools: Read, mcp__fixture__ping\n---\nYou call MCP tools.\n";
const CODEMODE_AGENT = "---\nname: codemode-agent\ndescription: scripts only\ntools: Read, codemode\n---\nYou run scripts.\n";

describe("which subagents get the MCP extension", () => {
	test("inherited tools, an MCP tool name: yes; a bare server name; built-in Explore, codemode alone: no", () => {
		const def = (tools?: string[]) => ({ name: "x", description: "", systemPrompt: "", model: "inherit", source: "user" as const, ...(tools ? { tools } : {}) });
		assert.equal(wantsMcp(def()), true);
		assert.equal(wantsMcp(def(["Read", "mcp__gitlab__whoami"])), true);
		assert.equal(wantsMcp(def(["mcp__gitlab"])), false);
		assert.equal(wantsMcp(def(["mcp__gitlab__*"])), false);
		assert.equal(wantsMcp(def(["Read", "Grep", "Glob", "LS"])), false);
		assert.equal(wantsMcp(def(["Read", "codemode"])), false);
	});
});

describe("a subagent with MCP tools", () => {
	let w: World;
	before(async () => {
		w = await createWorld({
			mcp: true,
			askTools: ["mcp__fixture__ping"],
			answer: () => true,
			userAgents: { "mcp-agent.md": MCP_AGENT, "codemode-agent.md": CODEMODE_AGENT },
		});
	});
	after(() => w.close());

	test("inheriting the orchestrator's tools calls an MCP tool, and the call raises an approval dialog", async () => {
		const { results } = await w.run([{ description: "ping it", prompt: "PING" }]);
		assert.equal(results[0].isError, false);
		assert.match(results[0].text, /pong/);
		const d = w.dialogs.find((x) => x.title.includes("Allow mcp__fixture__ping?"));
		assert.ok(d, "the ask-tools fixture raised the dialog");
		assert.match(d.title, /^\[general-purpose: ping it\] /);
		assert.match(d.message, /^mcp__fixture__ping /);
	});

	test("a declined dialog blocks the call", async () => {
		const w2 = await createWorld({ mcp: true, askTools: ["mcp__fixture__ping"], answer: () => false });
		try {
			const { results } = await w2.run([{ description: "ping it", prompt: "PING" }]);
			assert.doesNotMatch(results[0].text, /pong/);
			assert.equal(w2.dialogs.length, 1);
		} finally {
			await w2.close();
		}
	});

	test("a definition naming an MCP tool calls it after an approval dialog, and leaves no server behind", async () => {
		const before = w.dialogs.length;
		const { results } = await w.run([{ description: "ping it", subagent_type: "mcp-agent", prompt: "PING" }]);
		assert.match(results[0].text, /pong/);
		assert.ok(w.dialogs.length > before, "an ask dialog was raised");
		await waitFor(() => w.mcp.running().length === 0, "the MCP server to exit");
	});

	test("a definition that names codemode but no MCP tool starts no MCP server", async () => {
		const before = w.mcp.started().length;
		const { results } = await w.run([{ description: "script", subagent_type: "codemode-agent", prompt: "OK hi" }]);
		assert.equal(results[0].text, "done: hi");
		assert.equal(w.mcp.started().length, before);
	});
});

describe("a subagent with no MCP tools", () => {
	test("built-in Explore starts no MCP server process", async () => {
		const w = await createWorld({ mcp: true });
		try {
			const { results } = await w.run([{ description: "look", subagent_type: "Explore", prompt: "OK looked" }]);
			assert.equal(results[0].text, "done: looked");
			await new Promise((r) => setTimeout(r, 500));
			assert.equal(w.mcp.started().length, 0, "no fixture server was spawned");
		} finally {
			await w.close();
		}
	});
});
