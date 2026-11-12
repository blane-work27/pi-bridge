import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FETCH_TOOL, listAgents, resolveAgent, TOOL_MAP, type AgentDefinition } from "../../extensions/subagent/definitions.ts";
import { createWorld } from "./harness.ts";

const md = (fm: Record<string, string>, body = "Be useful.") =>
	`---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}\n`;

function folders(user: Record<string, string>, project: Record<string, string> = {}) {
	const root = mkdtempSync(join(tmpdir(), "defs-test-"));
	const userDir = join(root, "user");
	const cwd = join(root, "repo");
	mkdirSync(userDir, { recursive: true });
	mkdirSync(join(cwd, ".claude/agents"), { recursive: true });
	for (const [f, c] of Object.entries(user)) writeFileSync(join(userDir, f), c);
	for (const [f, c] of Object.entries(project)) writeFileSync(join(cwd, ".claude/agents", f), c);
	return { cwd, folders: { userDir } };
}

const byName = (defs: AgentDefinition[], name: string) => defs.find((d) => d.name === name);

describe("loading definitions", () => {
	test("user definitions load; project definitions only when the project is trusted", () => {
		const { cwd, folders: f } = folders({ "coder.md": md({ name: "coder", description: "Writes code", model: "sonnet" }) }, { "local.md": md({ name: "local", description: "Repo agent" }) });
		const untrusted = listAgents({ cwd, trusted: false, folders: f });
		assert.equal(byName(untrusted, "coder")?.source, "user");
		assert.equal(byName(untrusted, "coder")?.model, "sonnet");
		assert.equal(byName(untrusted, "local"), undefined);
		const trusted = listAgents({ cwd, trusted: true, folders: f });
		assert.equal(byName(trusted, "local")?.source, "project");
	});

	test("`thinking:` is read from the frontmatter; unset stays unset, as on the built-ins", () => {
		const { cwd, folders: f } = folders({ "deep.md": md({ name: "deep", description: "Thinks", thinking: "high" }), "plain.md": md({ name: "plain", description: "Does not" }) });
		const defs = listAgents({ cwd, trusted: false, folders: f });
		assert.equal(byName(defs, "deep")?.thinking, "high");
		assert.equal(byName(defs, "plain")?.thinking, undefined);
		assert.equal(byName(defs, "general-purpose")?.thinking, undefined);
		assert.equal(byName(defs, "Explore")?.thinking, undefined);
	});

	test("override order is project over user over built-in", () => {
		const { cwd, folders: f } = folders(
			{ "a.md": md({ name: "a", description: "user a" }), "Explore.md": md({ name: "Explore", description: "my explore" }), "b.md": md({ name: "b", description: "user b" }) },
			{ "b.md": md({ name: "b", description: "project b" }) },
		);
		const defs = listAgents({ cwd, trusted: true, folders: f });
		assert.equal(byName(defs, "Explore")?.description, "my explore");
		assert.equal(byName(defs, "Explore")?.source, "user");
		assert.equal(byName(defs, "b")?.description, "project b");
		assert.equal(defs.filter((d) => d.name === "b").length, 1);
		// untrusted: the user's b wins
		assert.equal(byName(listAgents({ cwd, trusted: false, folders: f }), "b")?.description, "user b");
	});

	test("Explore is read-only with bash on haiku, general-purpose is built in, and there is no Plan", () => {
		const { cwd, folders: f } = folders({});
		const defs = listAgents({ cwd, trusted: true, folders: f });
		assert.deepEqual(byName(defs, "Explore")?.tools, ["read", "grep", "find", "ls", "bash"]);
		assert.equal(byName(defs, "Explore")?.model, "haiku");
		assert.ok(byName(defs, "general-purpose"));
		assert.equal(byName(defs, "Plan"), undefined);
		const resolved = resolveAgent(byName(defs, "Explore")!, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
		assert.deepEqual(resolved.toolList, ["read", "bash", "grep", "find", "ls"]);
	});

	test("name falls back to the file name; tools accept a comma list, a YAML list or *", () => {
		const { cwd, folders: f } = folders({
			"plain.md": md({ description: "d", tools: "Read, Grep" }),
			"yaml.md": "---\ndescription: d\ntools:\n  - Bash\n  - Write\n---\nbody\n",
			"star.md": md({ name: "star", description: "d", tools: "*" }),
		});
		const defs = listAgents({ cwd, trusted: false, folders: f });
		assert.deepEqual(byName(defs, "plain")?.tools, ["Read", "Grep"]);
		assert.deepEqual(byName(defs, "yaml")?.tools, ["Bash", "Write"]);
		assert.equal(byName(defs, "star")?.tools, undefined);
		assert.equal(byName(defs, "plain")?.model, "inherit");
	});
});

describe("resolving tools", () => {
	const all = ["read", "bash", "edit", "write", "grep", "find", "ls", FETCH_TOOL, "codemode"];
	const def = (tools: string[]): AgentDefinition => ({ name: "t", description: "t", systemPrompt: "base", model: "inherit", tools, source: "user" });

	test("each Claude Code tool name maps to its pi tool", () => {
		const expected: Record<string, string> = { Read: "read", Grep: "grep", Glob: "find", Bash: "bash", Edit: "edit", MultiEdit: "edit", Write: "write", WebFetch: "fetch" };
		for (const [claude, pi] of Object.entries(expected)) {
			assert.deepEqual(TOOL_MAP[claude], [pi], claude);
			assert.deepEqual(resolveAgent(def([claude]), all).toolList, [pi], claude);
		}
	});

	test("no tools: line inherits the whole list; a tools: line narrows it", () => {
		assert.deepEqual(resolveAgent({ ...def([]), tools: undefined }, all).toolList, all);
		assert.deepEqual(resolveAgent(def(["Read", "Bash"]), all).toolList, ["read", "bash"]);
	});

	test("a tool pi lacks is dropped and the prompt says so", () => {
		const r = resolveAgent(def(["Read", "WebSearch"]), all);
		assert.deepEqual(r.toolList, ["read"]);
		assert.deepEqual(r.dropped, ["WebSearch"]);
		assert.match(r.systemPrompt, /^base/);
		assert.match(r.systemPrompt, /not available.*WebSearch/);
	});

	test("WebFetch resolves to the fetch tool even though the parent has none; no WebFetch, no fetch", () => {
		const parent = all.filter((t) => t !== FETCH_TOOL);
		const r = resolveAgent(def(["Read", "WebFetch"]), parent);
		assert.deepEqual(r.toolList, ["read", FETCH_TOOL]);
		assert.deepEqual(r.dropped, []);
		assert.doesNotMatch(r.systemPrompt, /not available/);
		assert.deepEqual(resolveAgent(def(["Read"]), parent).toolList, ["read"]);
		assert.deepEqual(resolveAgent({ ...def([]), tools: undefined }, parent).toolList, parent);
	});

	test("a tool the parent does not have is dropped; MCP and codemode names pass when inherited", () => {
		assert.deepEqual(resolveAgent(def(["Write"]), ["read"]).toolList, []);
		assert.deepEqual(resolveAgent(def(["Read", "codemode", "mcp__x__y"]), ["read", "codemode", "mcp__x__y"]).toolList, ["read", "codemode", "mcp__x__y"]);
	});
});

describe("definitions in a real session", () => {
	test("a definition's `thinking:` applies, the call's wins, and a bad value fails before a child starts", async () => {
		const w = await createWorld({ userAgents: { "deep.md": md({ name: "deep", description: "Thinks", thinking: "medium" }), "odd.md": md({ name: "odd", description: "Typo", thinking: "mediun" }) } });
		try {
			w.session.setThinkingLevel("low");
			const { results } = await w.run([
				{ description: "def", prompt: "OK x", subagent_type: "deep" },
				{ description: "call", prompt: "OK x", subagent_type: "deep", thinking: "high" },
				{ description: "bad", prompt: "OK x", subagent_type: "odd" },
			]);
			assert.equal(results[0].details.thinkingLevel, "medium");
			assert.equal(results[1].details.thinkingLevel, "high");
			assert.equal(results[2].isError, true);
			assert.match(results[2].text, /Unknown thinking level "mediun"/);
		} finally {
			await w.close();
		}
	});

	test("the tool description lists the agents and the usage contract; an unknown type lists them", async () => {
		const w = await createWorld({ userAgents: { "scout.md": md({ name: "scout", description: "Finds things" }) } });
		try {
			const tool: any = w.session.getAllTools().find((t: any) => t.name === "agent");
			for (const name of ["general-purpose", "Explore", "scout"]) assert.match(tool.description, new RegExp(`- ${name}: `));
			assert.doesNotMatch(tool.description, /- Plan: /);
			assert.match(tool.description, /sees none of this conversation/);
			assert.match(tool.description, /Only the subagent's final message/);
			assert.match(tool.description, /several agent calls in one message/);
			const { results } = await w.run([{ description: "x", prompt: "OK x", subagent_type: "Plan" }]);
			assert.equal(results[0].isError, true);
			assert.match(results[0].text, /Unknown subagent_type "Plan"\. Available: general-purpose, Explore, scout/);
		} finally {
			await w.close();
		}
	});

	test("a definition narrows the child's tools, drops WebSearch and tells the child", async () => {
		const w = await createWorld({ userAgents: { "reader.md": md({ name: "reader", description: "Reads", tools: "Read, WebSearch" }, "READER-BODY") } });
		try {
			const { results } = await w.run([
				{ description: "tools", prompt: "TOOLS", subagent_type: "reader" },
				{ description: "prompt", prompt: "PROMPT", subagent_type: "reader" },
			]);
			assert.deepEqual(JSON.parse(results[0].text), ["read"]);
			assert.match(results[1].text, /READER-BODY/);
			assert.match(results[1].text, /not available.*WebSearch/);
		} finally {
			await w.close();
		}
	});

	test("Explore's child has bash for read-only commands but no edit or write tools", async () => {
		const w = await createWorld();
		try {
			const { results } = await w.run([{ description: "look", prompt: "TOOLS", subagent_type: "Explore" }]);
			const tools: string[] = JSON.parse(results[0].text);
			for (const t of ["edit", "write", "agent", "codemode"]) assert.ok(!tools.includes(t), `no ${t}`);
			assert.ok(tools.includes("read"));
			assert.ok(tools.includes("bash"));
		} finally {
			await w.close();
		}
	});

	test("editing a definition between two calls changes the second call without a restart", async () => {
		const w = await createWorld({ userAgents: { "shifty.md": md({ name: "shifty", description: "Shifts" }, "FIRST-BODY") } });
		try {
			const one = await w.run([{ description: "p", prompt: "PROMPT", subagent_type: "shifty" }]);
			assert.match(one.results[0].text, /FIRST-BODY/);
			writeFileSync(join(w.userAgentsDir, "shifty.md"), md({ name: "shifty", description: "Shifts" }, "SECOND-BODY"));
			const two = await w.run([{ description: "p", prompt: "PROMPT", subagent_type: "shifty" }]);
			assert.match(two.results[0].text, /SECOND-BODY/);
			assert.doesNotMatch(two.results[0].text, /FIRST-BODY/);
		} finally {
			await w.close();
		}
	});

	test("project definitions are used only in a trusted project, and override the user's", async () => {
		const files = { userAgents: { "dup.md": md({ name: "dup", description: "user" }, "USER-BODY") }, projectAgents: { "dup.md": md({ name: "dup", description: "project" }, "PROJECT-BODY") } };
		const untrusted = await createWorld(files);
		const trusted = await createWorld({ ...files, trustedProject: true });
		try {
			const u = await untrusted.run([{ description: "p", prompt: "PROMPT", subagent_type: "dup" }]);
			assert.match(u.results[0].text, /USER-BODY/);
			const t = await trusted.run([{ description: "p", prompt: "PROMPT", subagent_type: "dup" }]);
			assert.match(t.results[0].text, /PROJECT-BODY/);
		} finally {
			await untrusted.close();
			await trusted.close();
		}
	});
});
