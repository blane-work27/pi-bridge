// The Herdr backend: a background subagent is an interactive pi-bridge in its own
// Herdr terminal. `hc` is a fake script (fixtures/fake-hc.mjs): no real terminal is ever created.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { formatStatus } from "../../extensions/subagent/control-tools.ts";
import { HerdrBackend } from "../../extensions/subagent/herdr-backend.ts";
import { createSubagentExtension } from "../../extensions/subagent/index.ts";
import { HcTerminals } from "../../extensions/subagent/herdr-terminals.ts";
import { createWorld, waitFor, type World } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(w: World, prompt: string, description = "herdr job") {
	const r = await w.tool("agent", { subagent_type: "general-purpose", description, prompt, run_in_background: true });
	assert.equal(r.isError, false, r.text);
	return { id: r.details.id as string, r };
}
const statusOf = async (w: World, id: string) => (await w.tool("agent_status", { id })).details[0];

describe("a background call inside Herdr", () => {
	let w: World;
	before(async () => {
		w = await createWorld({ herdr: true, persist: true });
	});
	after(() => w.close());

	test("launches a background hc terminal: no-notify, the orchestrator as parent, never outlive-parent, no-nesting marker", async () => {
		const { id, r } = await launch(w, "OK first");
		assert.equal(r.details.backend, "herdr");
		assert.equal(r.details.address, `t-${id}`);
		assert.match(r.text, new RegExp(`backend: herdr at t-${id}`));
		const [run] = w.herdr.calls("run");
		assert.equal(run.name, id);
		assert.equal(run.parent, "t1");
		assert.equal(run.cwd, w.cwd);
		assert.ok(run.flags.includes("--bg"));
		assert.ok(run.flags.includes("--no-notify"));
		assert.ok(!run.flags.includes("--outlive-parent"));
		const argv: string[] = run.argv;
		assert.deepEqual(argv.slice(0, 3), ["env", "PI_SUBAGENT=1", "pi-bridge"]);
		assert.match(argv[argv.indexOf("--model") + 1], /^bifrost\/claude-sub\/claude-sonnet-5-5:\w+$/);
		assert.ok(argv[argv.indexOf("--tools") + 1].split(",").includes("codemode"));
		assert.match(argv[argv.indexOf("--session") + 1], new RegExp(`\\.subagents/${id}\\.jsonl$`));
		assert.equal(argv.at(-1), "OK first");
		assert.ok(!argv.includes("--json"), "nothing of ours after `--`: the child's argv is only the program and its arguments");
		assert.equal(w.childCount(), 0, "no in-process child");
	});

	test("a call's thinking level is the one in the child's --model", async () => {
		const r = await w.tool("agent", { subagent_type: "general-purpose", description: "think", prompt: "OK think", thinking: "medium", run_in_background: true });
		assert.equal(r.isError, false, r.text);
		const run = w.herdr.calls("run").find((c: any) => c.name === r.details.id);
		const argv: string[] = run.argv;
		assert.match(argv[argv.indexOf("--model") + 1], /:medium$/);
	});

	test("idle at the launch turn is not finished; done at a later turn is, and the result is read from the session file", async () => {
		const { id } = await launch(w, "OK idle");
		// startup idle at turn 0 (the fake's initial state)
		await sleep(300);
		assert.equal((await statusOf(w, id)).state, "running");
		// done, but still the launch turn
		w.herdr.set(id, { status: "done", turn: 0 });
		await sleep(300);
		assert.equal((await statusOf(w, id)).state, "running");
		const before = w.parentNotices.length;
		w.herdr.set(id, { status: "working", turn: 1 });
		await sleep(100);
		w.herdr.finish(id, "HERDR-RESULT 1", 1);
		await waitFor(() => w.parentNotices.length === before + 1, "the finish notice");
		assert.match(w.parentNotices.at(-1)!, /finished/);
		assert.match(w.parentNotices.at(-1)!, /HERDR-RESULT 1/);
		const s = await statusOf(w, id);
		assert.equal(s.state, "idle");
		assert.equal(s.backend, "herdr");
		assert.equal(s.address, `t-${id}`);
		assert.equal(s.turn, 1);
		// the terminal stays open: nothing was killed
		assert.equal(w.herdr.calls("kill").length, 0);
	});

	test("agent_send types into the terminal, running or finished, and the next finish gives a new notice", async () => {
		const { id } = await launch(w, "OK send");
		const running = await w.tool("agent_send", { id, message: "careful now" });
		assert.equal(running.details.how, "steered");
		assert.deepEqual(w.herdr.calls("send").filter((c) => c.target === id).map((c) => c.text), ["careful now"]);
		const before = w.parentNotices.length;
		w.herdr.finish(id, "first answer", 1);
		await waitFor(() => w.parentNotices.length === before + 1, "first notice");
		assert.equal((await statusOf(w, id)).state, "idle");

		const cont = await w.tool("agent_send", { id, message: "and again" });
		assert.equal(cont.details.how, "continued");
		assert.deepEqual(w.herdr.calls("send").filter((c) => c.target === id).map((c) => c.text), ["careful now", "and again"]);
		// still the old turn: not a new finish
		await sleep(300);
		assert.equal(w.parentNotices.length, before + 1);
		w.herdr.set(id, { status: "working", turn: 2 });
		await sleep(50);
		w.herdr.finish(id, "second answer", 2);
		await waitFor(() => w.parentNotices.length === before + 2, "second notice");
		assert.match(w.parentNotices.at(-1)!, /second answer/);
	});

	test("agent_stop kills the terminal and the subagent reports stopped", async () => {
		const { id } = await launch(w, "OK stop");
		const r = await w.tool("agent_stop", { id });
		assert.equal(r.isError, false, r.text);
		assert.deepEqual(w.herdr.calls("kill").map((c) => c.target), [id]);
		assert.equal((await statusOf(w, id)).state, "stopped");
		// idempotent
		await w.tool("agent_stop", { id });
		assert.equal(w.herdr.calls("kill").length, 1);
		const before = w.parentNotices.length;
		await sleep(150);
		assert.equal(w.parentNotices.length, before, "a stopped subagent gives no notice");
	});

	test("a terminal that ends before it finishes fails the subagent", async () => {
		const { id } = await launch(w, "OK dies");
		const before = w.parentNotices.length;
		w.herdr.set(id, { status: "exited", turn: 0, ended: true, reason: "exit" } as any);
		await waitFor(() => w.parentNotices.length === before + 1, "the failure notice");
		assert.match(w.parentNotices.at(-1)!, /failed/);
		assert.equal((await statusOf(w, id)).state, "failed");
	});

	test("a status change reported as ended (reason status) does not end the subagent", async () => {
		const t = new HcTerminals({
			runner: async () => ({ code: 0, stdout: '{"children":[],"ended":true,"exit_code":null,"reason":"status","signal":null,"status":"idle","terminal":"t1","turn":0}', stderr: "" }),
		});
		assert.equal((await t.wait("t1")).ended, false);
		const exited = new HcTerminals({ runner: async () => ({ code: 0, stdout: '{"ended":true,"exit_code":0,"reason":"exit","status":null,"turn":2}', stderr: "" }) });
		assert.equal((await exited.wait("t1")).ended, true);
		const killed = new HcTerminals({ runner: async () => ({ code: 0, stdout: '{"ended":true,"exit_code":null,"reason":"killed","status":null,"turn":2}', stderr: "" }) });
		assert.equal((await killed.wait("t1")).ended, true);
	});

	test("an error in the child's last message is reported as a failure", async () => {
		const { id } = await launch(w, "OK err");
		const before = w.parentNotices.length;
		w.herdr.finish(id, "", 1, { stopReason: "error", errorMessage: "provider exploded" });
		await waitFor(() => w.parentNotices.length === before + 1, "the failure notice");
		assert.match(w.parentNotices.at(-1)!, /failed/);
		assert.match(w.parentNotices.at(-1)!, /provider exploded/);
	});
});

describe("choosing the backend", () => {
	test("HC_SCOPE alone does not select Herdr", async () => {
		const w = await createWorld();
		try {
			process.env.HC_SCOPE = "s1";
			const { r } = await launch(w, "OK scope").then((x) => ({ r: x.r }));
			assert.equal(r.details.backend, "in-process");
			assert.equal(w.herdr.calls("run").length, 0);
		} finally {
			delete process.env.HC_SCOPE;
			await w.close();
		}
	});

	test("HC_TERMINAL_ID selects Herdr, read at each launch", async () => {
		const w = await createWorld();
		try {
			assert.equal((await launch(w, "OK a")).r.details.backend, "in-process");
			process.env.HC_TERMINAL_ID = "t9";
			const b = await launch(w, "OK b");
			assert.equal(b.r.details.backend, "herdr");
			assert.equal(w.herdr.calls("run")[0].parent, "t9");
		} finally {
			delete process.env.HC_TERMINAL_ID;
			await w.close();
		}
	});

	test("foreground calls stay in-process inside Herdr", async () => {
		const w = await createWorld({ herdr: true });
		try {
			const run = await w.run([{ description: "fg", prompt: "OK foreground" }]);
			assert.equal(run.results[0].isError, false, run.results[0].text);
			assert.match(run.results[0].text, /done: foreground/);
			assert.equal(w.herdr.calls("run").length, 0);
		} finally {
			await w.close();
		}
	});
});

describe("concurrency and shutdown", () => {
	test("a Herdr child holds a slot until it finishes; the queued one launches after", async () => {
		const saved = process.env.SUBAGENT_CONCURRENCY;
		process.env.SUBAGENT_CONCURRENCY = "1";
		const w = await createWorld({ herdr: true, persist: true });
		try {
			const a = await launch(w, "OK one");
			const b = await launch(w, "OK two");
			assert.equal(b.r.details.address, undefined, "queued: no terminal yet");
			assert.equal((await statusOf(w, b.id)).state, "queued");
			assert.equal(w.herdr.calls("run").length, 1);
			w.herdr.finish(a.id, "one done", 1);
			await waitFor(() => w.herdr.calls("run").length === 2, "the queued subagent's launch");
			let s = await statusOf(w, b.id);
			for (let i = 0; i < 50 && !s.address; i++) {
				await sleep(20);
				s = await statusOf(w, b.id);
			}
			assert.equal(s.state, "running");
			assert.equal(s.address, `t-${b.id}`);
		} finally {
			if (saved === undefined) delete process.env.SUBAGENT_CONCURRENCY;
			else process.env.SUBAGENT_CONCURRENCY = saved;
			await w.close();
		}
	});

	test("when the orchestrator exits, every Herdr child is killed, finished or not", async () => {
		const w = await createWorld({ herdr: true, persist: true });
		try {
			const a = await launch(w, "OK one");
			const b = await launch(w, "OK two");
			w.herdr.finish(a.id, "one done", 1);
			await waitFor(() => w.parentNotices.length === 1, "a's notice");
			await w.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			assert.deepEqual(w.herdr.calls("kill").map((c) => c.target).sort(), [a.id, b.id].sort());
		} finally {
			await w.close();
		}
	});

	test("a failing hc run fails the call and leaves no subagent behind", async () => {
		const w = await createWorld({ herdr: true });
		try {
			w.herdr.failRuns();
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "x", prompt: "OK x", run_in_background: true });
			assert.equal(r.isError, true);
			assert.match(r.text, /the core is not reachable/);
			assert.equal((await w.tool("agent_status", {})).details.length, 0);
		} finally {
			await w.close();
		}
	});
});

describe("the definition and the prompt", () => {
	test("the definition goes in as an appended system prompt, with its tools; a prompt starting with a dash is not read as a flag", async () => {
		const w = await createWorld({
			herdr: true,
			userAgents: { "reader.md": "---\nname: reader\ndescription: reads\ntools: Read, Grep\n---\nYou only read. SYSTEM-MARKER\n" },
		});
		try {
			const r = await w.tool("agent", { subagent_type: "reader", description: "r", prompt: "--help me", run_in_background: true });
			assert.equal(r.isError, false, r.text);
			const argv: string[] = w.herdr.calls("run")[0].argv;
			assert.match(argv[argv.indexOf("--append-system-prompt") + 1], /SYSTEM-MARKER/);
			assert.ok(argv[argv.indexOf("--tools") + 1].split(",").includes("read"));
			assert.ok(!argv[argv.indexOf("--tools") + 1].split(",").includes("bash"), "narrowed to the definition");
			assert.equal(argv.at(-1), "\n--help me");
		} finally {
			await w.close();
		}
	});

	test("a WebFetch definition puts fetch in --tools", async () => {
		const w = await createWorld({
			herdr: true,
			userAgents: { "web.md": "---\nname: web\ndescription: reads the web\ntools: Read, WebFetch\n---\nBrowse.\n" },
		});
		try {
			const r = await w.tool("agent", { subagent_type: "web", description: "r", prompt: "go", run_in_background: true });
			assert.equal(r.isError, false, r.text);
			const argv: string[] = w.herdr.calls("run")[0].argv;
			assert.ok(argv[argv.indexOf("--tools") + 1].split(",").includes("fetch"));
		} finally {
			await w.close();
		}
	});
});

describe("no nesting in a Herdr child", () => {
	const stubPi = () => {
		const calls: string[] = [];
		return { calls, pi: { registerTool: () => calls.push("tool"), on: () => calls.push("on"), getActiveTools: () => [] } as any };
	};

	test("the extension registers no subagent tools when the marker is set", () => {
		const names: string[] = [];
		const pi = { registerTool: (t: any) => names.push(t.name), on: () => names.push("on"), getActiveTools: () => [] } as any;
		createSubagentExtension(undefined, { env: { HC_TERMINAL_ID: "t5", PI_SUBAGENT: "1" } })(pi);
		for (const n of ["agent", "agent_send", "agent_stop", "agent_status"]) assert.ok(!names.includes(n), n);
		assert.ok(!names.includes("on"));
	});

	test("under the marker only the fetch tool is registered, so --tools decides whether it is active", () => {
		const names: string[] = [];
		const pi = { registerTool: (t: any) => names.push(t.name), on: () => names.push("on"), getActiveTools: () => [] } as any;
		createSubagentExtension(undefined, { env: { HC_TERMINAL_ID: "t5", PI_SUBAGENT: "1" } })(pi);
		assert.deepEqual(names, ["fetch"]);
	});

	test("without the marker it registers its tools", () => {
		const { calls, pi } = stubPi();
		createSubagentExtension(undefined, { env: { HC_TERMINAL_ID: "t5" } })(pi);
		assert.ok(calls.filter((c) => c === "tool").length >= 4);
	});
});

describe("HcTerminals", () => {
	test("builds the hc command lines and parses the JSON", async () => {
		const seen: string[][] = [];
		const t = new HcTerminals({
			bin: "hcx",
			runner: async (bin, args) => {
				assert.equal(bin, "hcx");
				seen.push(args);
				return { code: 0, stdout: args[0] === "run" ? '{"address":"t7"}' : args[0] === "wait" ? '{"status":"done","turn":3,"ended":false}' : "{}", stderr: "" };
			},
		});
		assert.deepEqual(await t.run({ name: "n", parent: "t1", cwd: "/w", argv: ["pi-bridge", "hi"] }), { address: "t7" });
		assert.deepEqual(await t.wait("n"), { status: "done", turn: 3, ended: false });
		await t.send("n", "msg");
		await t.kill("n");
		assert.deepEqual(seen, [
			["run", "--json", "--bg", "--name", "n", "--parent", "t1", "--no-notify", "--cwd", "/w", "--", "pi-bridge", "hi"],
			["wait", "--json", "n"],
			["send", "--json", "n", "msg"],
			["kill", "--json", "n"],
		]);
	});

	test("a failed hc call throws with Herdr's message", async () => {
		const t = new HcTerminals({ runner: async () => ({ code: 3, stdout: '{"error":{"message":"no terminal \\"x\\""}}', stderr: "" }) });
		await assert.rejects(t.get("x"), /no terminal "x"/);
	});
});

describe("a Herdr child starts MCP only when the definition asks", () => {
	test("Explore launches with --no-mcp, general-purpose without it", async () => {
		const w = await createWorld({ herdr: true });
		try {
			const a = await w.tool("agent", { subagent_type: "Explore", description: "e", prompt: "x", run_in_background: true });
			const b = await w.tool("agent", { subagent_type: "general-purpose", description: "g", prompt: "x", run_in_background: true });
			const argvOf = (id: string): string[] => w.herdr.calls("run").find((c) => c.name === id).argv;
			assert.ok(argvOf(a.details.id).includes("--no-mcp"));
			assert.ok(!argvOf(b.details.id).includes("--no-mcp"));
		} finally {
			await w.close();
		}
	});
});

describe("agent_status on a Herdr subagent stays current", () => {
	test("a turn the user drove by typing into the terminal shows, and the last activity stays", async () => {
		const w = await createWorld({ herdr: true, persist: true });
		try {
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "h", prompt: "x", run_in_background: true });
			const id = r.details.id as string;
			await sleep(100);
			w.herdr.set(id, { status: "working", turn: 1 });
			await sleep(100);
			w.herdr.finish(id, "R1", 1);
			await waitFor(() => w.parentNotices.length === 1, "finish notice");
			const before = (await w.tool("agent_status", { id })).details[0];
			assert.equal(before.turn, 1);
			w.herdr.set(id, { status: "done", turn: 3 });
			const after = (await w.tool("agent_status", { id })).details[0];
			assert.equal(after.turn, 3);
			assert.equal(after.lastActivity, before.lastActivity);
		} finally {
			await w.close();
		}
	});
});

function fakeTerminals(over: Record<string, unknown> = {}) {
	const kills: string[] = [];
	const t: any = {
		run: async () => ({ address: "t-x" }),
		wait: (_t: string, signal?: AbortSignal) =>
			new Promise<any>((_res, rej) => {
				if (signal?.aborted) return rej(new Error("aborted"));
				signal?.addEventListener("abort", () => rej(new Error("aborted")));
			}),
		send: async () => {},
		kill: async (x: string) => void kills.push(x),
		get: async () => ({ status: "idle", turn: 0, ended: false }),
		...over,
	};
	return { t, kills };
}
const hspec = (extra: object = {}): any => ({ id: "general-purpose-abcde", agentType: "general-purpose", description: "d", cwd: "/tmp", prompt: "p", model: { provider: "p", id: "m" }, thinkingLevel: "off", tools: [], ui: undefined, mode: "print", projectTrusted: false, transcriptDir: mkdtempSync(join(tmpdir(), "hr-")), ...extra });


describe("the Herdr backend: races and edge cases", () => {
	test("a stop while hc run is in flight kills the terminal once it exists", async () => {
		const { t, kills } = fakeTerminals({ run: async () => { await sleep(300); return { address: "t-x" }; } });
		const b = new HerdrBackend({ terminals: t, parent: () => "t1", piBin: "pi-bridge" });
		const spec = hspec();
		const started = b.start(spec).then(() => "started", (e) => String(e));
		await sleep(50);
		await b.stop(spec.id);
		assert.match(await started, /stopped/);
		assert.deepEqual(kills, [spec.id]);
	});

	test("agent_send after the user drove the child to a later turn waits for a turn after that one", async () => {
		const w = await createWorld({ herdr: true, persist: true });
		try {
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "hj", prompt: "OK first", run_in_background: true });
			const id = r.details.id;
			await waitFor(() => w.herdr.calls("run").length === 1, "run");
			w.herdr.finish(id, "first answer", 1);
			await waitFor(() => w.parentNotices.length === 1, "first notice");
			// The user types into the child's terminal; it answers (turn 2) with nobody watching.
			w.herdr.finish(id, "answer to the user's own question", 2);
			await sleep(300);
			const s = await w.tool("agent_send", { id, message: "now do the orchestrator's follow-up" });
			assert.equal(s.isError, false, s.text);
			await sleep(800);
			assert.equal(w.parentNotices.length, 1, "the stale turn 2 must not be reported as the answer");
			w.herdr.set(id, { status: "working", turn: 3 });
			await sleep(100);
			w.herdr.finish(id, "the follow-up answer", 3);
			await waitFor(() => w.parentNotices.length === 2, "second notice");
			assert.match(w.parentNotices[1], /the follow-up answer/);
		} finally {
			await w.close();
		}
	});

	test("a prompt starting with @ is not read as a file to include", async () => {
		const w = await createWorld({ herdr: true });
		try {
			await w.tool("agent", { subagent_type: "general-purpose", description: "r", prompt: "@notes.md summarise", run_in_background: true });
			assert.equal(w.herdr.calls("run")[0].argv.at(-1), "\n@notes.md summarise");
		} finally {
			await w.close();
		}
	});

	test("agent_status does not claim 0 tool calls or 0 tokens", async () => {
		const w = await createWorld({ herdr: true });
		try {
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "r", prompt: "OK x", run_in_background: true });
			const s = await w.tool("agent_status", { id: r.details.id });
			assert.doesNotMatch(s.text, /tool calls|tokens/);
		} finally {
			await w.close();
		}
		const inProc = formatStatus({ id: "a", type: "t", description: "d", backend: "in-process", state: "idle", turn: 1, lastActivity: "x", lastActivityAt: "y", toolCalls: 2, tokens: 30 });
		assert.match(inProc, /2 tool calls, 30 tokens/);
	});

	test("a queued launch that failed in hc run does not claim its worktree is in use", async () => {
		const w = await createWorld({ herdr: true, git: true });
		try {
			process.env.SUBAGENT_CONCURRENCY = "1";
			const gate = join(w.root, "slot");
			const first = await w.tool("agent", { subagent_type: "general-purpose", description: "a", prompt: "OK a", run_in_background: true });
			assert.equal(first.isError, false);
			const second = await w.tool("agent", { subagent_type: "general-purpose", description: "b", prompt: "OK b", isolation: "worktree", run_in_background: true });
			assert.match(second.text, /Started/);
			assert.equal(w.herdr.calls("run").length, 1, "the second one is queued");
			w.herdr.failRuns();
			w.herdr.finish(first.details.id, "done", 1);
			await waitFor(() => w.parentNotices.length >= 2, "both notices");
			const failed = w.parentNotices.find((n) => /failed/.test(n))!;
			assert.ok(failed, w.parentNotices.join("\n---\n"));
			assert.doesNotMatch(failed, /in use/);
			assert.ok(!existsSync(second.details.worktree.path), "no terminal, so the clean worktree is removed");
			void gate;
		} finally {
			delete process.env.SUBAGENT_CONCURRENCY;
			await w.close();
		}
	});
});
