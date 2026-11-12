import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runAsSubagent } from "../../extensions/subagent/child-marker.ts";
import { resumeSubagent } from "../../extensions/subagent/in-process.ts";
import subagentExtension from "../../extensions/subagent/index.ts";
import { createWorld, holdPid, isRunning, waitFor, type Dialog, type World } from "./harness.ts";

const sorted = (xs: string[]) => [...xs].sort();

describe("model resolution through the agent tool", () => {
	let w: World;
	before(async () => {
		w = await createWorld();
	});
	after(() => w.close());

	test("sonnet, opus, haiku and an icr-* id (bare or full ref) run the child on that model", async () => {
		const wanted: Array<[string, string]> = [
			["sonnet", "claude-sub/claude-sonnet-5-5"],
			["opus", "claude-sub/claude-opus-5-5"],
			["haiku", "claude-sub/claude-haiku-5-5"],
			["icr-qwen/qwen3.8", "icr-qwen/qwen3.8"],
			["bifrost/icr-qwen/qwen3.8", "icr-qwen/qwen3.8"],
		];
		const { results } = await w.run(wanted.map(([model], i) => ({ description: `m${i}`, prompt: "OK hi", model })));
		results.forEach((r, i) => {
			assert.equal(r.isError, false, r.text);
			assert.equal(r.details.model, wanted[i][1]);
		});
	});

	test("without a model the child inherits the orchestrator's model and thinking level", async () => {
		w.session.setThinkingLevel("low");
		const { results } = await w.run([{ description: "inherit", prompt: "OK hi" }, { description: "inherit2", prompt: "OK hi", model: "inherit" }]);
		for (const r of results) {
			assert.equal(r.details.model, w.session.model?.id);
			assert.equal(r.details.thinkingLevel, "low");
		}
	});

	test("a call's thinking level reaches the child, over the definition's and the orchestrator's", async () => {
		w.session.setThinkingLevel("low");
		const { results } = await w.run([{ description: "think", prompt: "OK hi", thinking: "medium" }]);
		assert.equal(results[0].isError, false, results[0].text);
		assert.equal(results[0].details.thinkingLevel, "medium");
	});

	test("an unknown id fails with the known ids and starts no child", async () => {
		const children = w.childCount();
		const { results } = await w.run([{ description: "typo", prompt: "OK hi", model: "claude-sonet" }]);
		assert.equal(results[0].isError, true);
		assert.match(results[0].text, /Unknown model "claude-sonet"/);
		assert.match(results[0].text, /bifrost\/icr-qwen\/qwen3\.8/);
		assert.equal(w.childCount(), children, "no child session was created");
	});
});

describe("the agent tool", () => {
	let w: World;
	before(async () => {
		w = await createWorld();
	});
	after(() => w.close());

	test("is registered with description, prompt, subagent_type and optional model and thinking", () => {
		const tool: any = w.session.getAllTools().find((t: any) => t.name === "agent");
		assert.ok(tool, "agent is registered");
		assert.deepEqual(sorted(Object.keys(tool.parameters.properties)), ["description", "isolation", "model", "prompt", "run_in_background", "subagent_type", "thinking"]);
		assert.deepEqual(sorted(tool.parameters.required), ["description", "prompt", "subagent_type"]);
		assert.match(tool.description, /general-purpose/);
	});

	test("a general-purpose subagent's final message comes back as the tool result", async () => {
		const { results } = await w.run([{ description: "say hi", prompt: "OK hello" }]);
		assert.equal(results[0].isError, false);
		assert.equal(results[0].text, "done: hello");
		assert.equal(results[0].details.agent, "general-purpose");
	});

	test("an unknown subagent_type fails and lists the available ones", async () => {
		const { results } = await w.run([{ description: "x", prompt: "OK x", subagent_type: "nope" }]);
		assert.equal(results[0].isError, true);
		assert.match(results[0].text, /Unknown subagent_type "nope"/);
		assert.match(results[0].text, /general-purpose/);
	});

	test("the child loads the user's AGENTS.md rules and the settings' extensions", async () => {
		const { results } = await w.run([{ description: "rules", prompt: "PROMPT" }]);
		assert.match(results[0].text, /RULE-MARKER/);
		const tools = await w.run([{ description: "tools", prompt: "TOOLS" }]);
		assert.ok(JSON.parse(tools.results[0].text).includes("probe_ask"), "the probe extension's tool is in the child");
	});

	test("the child's tools are the parent's active tools minus agent and the jank tools", async () => {
		const { results } = await w.run([{ description: "tools", prompt: "TOOLS" }]);
		const parent: string[] = w.parentToolNames.at(-1)!;
		for (const t of ["agent", "jank_fake", "probe_ask", "bash", "codemode"]) assert.ok(parent.includes(t), `the parent has ${t}`);
		const child: string[] = JSON.parse(results[0].text);
		assert.deepEqual(
			sorted(child),
			sorted(parent.filter((t) => !t.startsWith("agent") && !t.startsWith("jank_"))),
		);
		assert.ok(!child.includes("agent") && !child.includes("jank_fake"));
	});

	test("a child that errors fails with the reason, and a sibling in the same message still finishes", async () => {
		const { results } = await w.run([
			{ description: "breaks", prompt: "FAIL the gateway exploded" },
			{ description: "fine", prompt: "OK fine" },
		]);
		assert.equal(results[0].isError, true);
		assert.match(results[0].text, /the gateway exploded/);
		assert.equal(results[1].isError, false);
		assert.equal(results[1].text, "done: fine");
	});

	test("the extension registers nothing when it loads inside a subagent", () => {
		const registered: string[] = [];
		const pi: any = { registerTool: (t: any) => registered.push(t.name), on: () => {} };
		runAsSubagent(() => subagentExtension(pi));
		assert.deepEqual(registered, []);
		subagentExtension(pi);
		assert.deepEqual(registered, ["agent_send", "agent_stop", "agent_status", "agent"]);
	});
});

describe("dialogs raised by a child", () => {
	let w: World;
	before(async () => {
		w = await createWorld();
	});
	after(() => w.close());

	test("carry the [<type>: <description>] prefix, and with two children asking at once each answer reaches the child that asked", async () => {
		const run = w.start([
			{ description: "child A", prompt: "ASK a" },
			{ description: "child B", prompt: "ASK b" },
		]);
		await waitFor(() => w.dialogs.length === 2, "both dialogs to be raised");
		const byTag = (tag: string): Dialog => w.dialogs.find((d) => d.title.includes(`Allow ${tag}?`))!;
		assert.equal(byTag("a").title, "[general-purpose: child A] Allow a?");
		assert.equal(byTag("b").title, "[general-purpose: child B] Allow b?");
		// answer in the opposite order, one yes and one no
		byTag("b").resolve(false);
		byTag("a").resolve(true);
		await run.done;
		const [a, b] = run.results();
		assert.equal(a.text, "a approved");
		assert.equal(b.text, "b denied");
	});
});

describe("aborting", () => {
	let w: World;
	before(async () => {
		w = await createWorld();
	});
	after(() => w.close());

	test("stops the child mid-turn, and the tool returns a failed result", async () => {
		const marker = join(w.root, "child-running");
		const run = w.start([{ description: "long job", prompt: `HOLD ${marker}` }]);
		await waitFor(() => existsSync(marker), "the child to be mid-turn");
		const sleep = holdPid(marker);
		assert.equal(isRunning(sleep), true, "the child's command is running");
		await w.abort();
		await run.done;
		const [r] = run.results();
		assert.ok(r, "the agent call produced a result");
		assert.equal(r.isError, true);
		assert.equal(isRunning(sleep), false, "the child's command was killed");
	});
});

describe("teardown", () => {
	let w: World;
	before(async () => {
		w = await createWorld({ mcp: true });
	});
	after(() => w.close());

	test("leaves no MCP server running after a child finishes", async () => {
		const before = w.mcp.started().length;
		await w.run([{ description: "ok", prompt: "BASH sleep 1" }]);
		assert.ok(w.mcp.started().length > before, "the child started the MCP fixture server");
		await waitFor(() => w.mcp.running().length === 0, "the MCP server to exit");
	});

	test("leaves no MCP server running after a child errors", async () => {
		const before = w.mcp.started().length;
		const { results } = await w.run([{ description: "bad", prompt: "SLOWFAIL boom" }]);
		assert.equal(results[0].isError, true);
		assert.match(results[0].text, /boom/);
		assert.ok(w.mcp.started().length > before, "the child started the MCP fixture server");
		await waitFor(() => w.mcp.running().length === 0, "the MCP server to exit");
	});

	test("leaves no MCP server running after a child is aborted", async () => {
		const before = w.mcp.started().length;
		const marker = join(w.root, "abort-running");
		const run = w.start([{ description: "long", prompt: `HOLD ${marker}` }]);
		await waitFor(() => existsSync(marker), "the child to be mid-turn");
		await waitFor(() => w.mcp.running().length > 0, "the MCP server to start");
		assert.ok(w.mcp.started().length > before, "the child started the MCP fixture server");
		await w.abort();
		await run.done;
		await waitFor(() => w.mcp.running().length === 0, "the MCP server to exit");
	});
});

describe("project trust", () => {
	test("a child does not load an untrusted project's extensions", async () => {
		const w = await createWorld({ untrustedProject: true });
		try {
			const { results } = await w.run([{ description: "x", prompt: "OK x" }]);
			assert.equal(results[0].text, "done: x");
			assert.equal(w.untrustedMarkerExists(), false);
		} finally {
			await w.close();
		}
	});
});

describe("saved, resumable transcripts", () => {
	test("a finished subagent's transcript is under the orchestrator's session and its path is in the details", async () => {
		const w = await createWorld({ persist: true });
		try {
			const { results } = await w.run([{ description: "say hi", prompt: "OK hello" }]);
			const file: string = results[0].details.transcript;
			assert.ok(existsSync(file), "the transcript file exists");
			const orch = w.session.sessionFile!;
			assert.equal(dirname(file), orch.replace(/\.jsonl$/, ".subagents"));
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
			assert.equal(lines[0].type, "session");
			assert.equal(lines[0].parentSession, orch);
			assert.match(JSON.stringify(lines), /done: hello/);
		} finally {
			await w.close();
		}
	});

	test("the transcript can be reopened and continued, and the continuation sees the earlier turns", async () => {
		const w = await createWorld({ persist: true });
		try {
			const { results } = await w.run([{ description: "say hi", prompt: "OK hello" }]);
			const file: string = results[0].details.transcript;
			const outcome = await resumeSubagent(file, "and again", {
				cwd: w.cwd,
				label: "resume",
				model: w.session.model!,
				thinkingLevel: "off",
				tools: ["bash"],
				ui: undefined,
				mode: "rpc",
				projectTrusted: false,
				signal: undefined,
				transcriptDir: dirname(file),
			});
			assert.equal(outcome.transcript, file, "continues the same file");
			assert.match(outcome.text, /continued: and again \| first: OK hello \| messages: 3/);
			assert.match(readFileSync(file, "utf8"), /continued: and again/);
		} finally {
			await w.close();
		}
	});

	test("with no orchestrator session file the subagent runs and its transcript goes to the state dir", async () => {
		const w = await createWorld();
		try {
			assert.equal(w.session.sessionFile, undefined);
			const { results } = await w.run([{ description: "say hi", prompt: "OK hello" }]);
			assert.equal(results[0].isError, false);
			assert.equal(results[0].text, "done: hello");
			const file: string = results[0].details.transcript;
			assert.ok(existsSync(file));
			assert.ok(file.startsWith(join(w.stateDir, "subagent/transcripts")), file);
		} finally {
			await w.close();
		}
	});
});

describe("the agent tool description", () => {
	test("the tool description lists 'Available agents', not agent types", async () => {
		const w = await createWorld();
		try {
			const tool: any = w.session.getAllTools().find((t: any) => t.name === "agent");
			assert.match(tool.description, /Available agents:/);
			assert.doesNotMatch(tool.description, /agent types/i);
		} finally {
			await w.close();
		}
	});
});
