// Background subagents in-process: immediate return, finish notice, agent_send / agent_stop /
// agent_status, the concurrency cap, and teardown with the orchestrator.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AgentRegistry, newAgentId, type AgentBackend, type AgentStatus } from "../../extensions/subagent/backend.ts";
import { createWorld, holdPid, isRunning, waitFor, type World } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const release = (gate: string) => writeFileSync(`${gate}.go`, "");
const started = (gate: string) => existsSync(`${gate}.started`);

/** Launch a background subagent and return its id and the raw call result. */
async function launch(w: World, prompt: string, description = "bg job") {
	const r = await w.tool("agent", { subagent_type: "general-purpose", description, prompt, run_in_background: true });
	assert.equal(r.isError, false, r.text);
	return { id: r.details.id as string, r };
}

const statusOf = async (w: World, id: string): Promise<AgentStatus> => (await w.tool("agent_status", { id })).details[0];

describe("a background call", () => {
	let w: World;
	before(async () => {
		w = await createWorld();
	});
	after(() => w.close());

	test("returns its id and backend before the subagent finishes", async () => {
		const gate = join(w.root, "gate-1");
		const { id, r } = await launch(w, `GATE ${gate}`);
		assert.match(id, /^general-purpose-[a-z0-9]{5}$/);
		assert.equal(r.details.backend, "in-process");
		assert.equal(r.details.background, true);
		assert.equal(r.details.address, undefined);
		assert.match(r.text, new RegExp(`Started background subagent ${id}`));
		await waitFor(() => started(gate), "the subagent to start its work");
		assert.equal((await statusOf(w, id)).state, "running", "the call returned while the subagent was still running");
		assert.equal(w.parentNotices.length, 0);
		release(gate);
		await waitFor(() => w.parentNotices.length === 1, "the finish notice");
	});

	test("on finish the orchestrator gets a notice with the final message, and it starts a parent turn", async () => {
		const seen = w.parentNotices.length;
		const { id } = await launch(w, "OK all done", "quick one");
		await waitFor(() => w.parentNotices.length === seen + 1, "a parent turn started by the notice");
		const notice = w.parentNotices.at(-1)!;
		assert.match(notice, new RegExp(`Background subagent ${id} \\(general-purpose: quick one\\) finished`));
		assert.match(notice, /done: all done/);
		// the notice is a custom message in the orchestrator's session, shown to the user
		const entry: any = w.session.sessionManager.getEntries().findLast((e: any) => e.type === "custom_message");
		assert.equal(entry.customType, "subagent-finished");
		assert.equal(entry.display, true);
		assert.equal((await statusOf(w, id)).state, "idle");
	});

	test("a failing subagent sends a failure notice", async () => {
		const seen = w.parentNotices.length;
		const { id } = await launch(w, "FAIL the gateway exploded");
		await waitFor(() => w.parentNotices.length === seen + 1, "the failure notice");
		assert.match(w.parentNotices.at(-1)!, new RegExp(`${id}.*failed`));
		assert.match(w.parentNotices.at(-1)!, /the gateway exploded/);
		const s = await statusOf(w, id);
		assert.equal(s.state, "failed");
		assert.match(s.error!, /gateway exploded/);
	});
});

describe("agent_send", () => {
	let w: World;
	before(async () => {
		w = await createWorld();
	});
	after(() => w.close());

	test("steers a running subagent, which sees the message", async () => {
		const gate = join(w.root, "gate-steer");
		const { id } = await launch(w, `GATE ${gate}`);
		await waitFor(() => started(gate), "the subagent to be mid-turn");
		const r = await w.tool("agent_send", { id, message: "change course" });
		assert.equal(r.isError, false, r.text);
		assert.equal(r.details.how, "steered");
		release(gate);
		await waitFor(() => w.parentNotices.length === 1, "the finish notice");
		assert.match(w.parentNotices[0], /continued: change course/);
	});

	test("continues a finished subagent from its transcript, which sees the earlier turns", async () => {
		const { id } = await launch(w, "OK first");
		await waitFor(() => w.parentNotices.length === 2, "the first finish notice");
		const r = await w.tool("agent_send", { id, message: "and again" });
		assert.equal(r.isError, false, r.text);
		assert.equal(r.details.how, "continued");
		await waitFor(() => w.parentNotices.length === 3, "the finish notice of the continuation");
		assert.match(w.parentNotices[2], /continued: and again \| first: OK first \| messages: 3/);
		const s = await statusOf(w, id);
		assert.equal(s.state, "idle");
		assert.equal(s.turn, 2, "turns count across the continuation");
	});

	test("a background subagent and its continuation leave no MCP server behind", async () => {
		const wm = await createWorld({ mcp: true });
		try {
			const { id } = await launch(wm, "BASH sleep 1");
			await waitFor(() => wm.parentNotices.length === 1, "the finish notice");
			assert.ok(wm.mcp.started().length > 0, "the background subagent started the MCP fixture");
			await wm.tool("agent_send", { id, message: "again" });
			await waitFor(() => wm.parentNotices.length === 2, "the continuation to finish");
			await waitFor(() => wm.mcp.running().length === 0, "the MCP servers to exit");
		} finally {
			await wm.close();
		}
	});
});

describe("agent_stop", () => {
	test("stops a running subagent, leaves no MCP process and no notice", async () => {
		const w = await createWorld({ mcp: true });
		try {
			const marker = join(w.root, "bg-running");
			const { id } = await launch(w, `HOLD ${marker}`);
			await waitFor(() => existsSync(marker), "the subagent to be mid-turn");
			await waitFor(() => w.mcp.running().length > 0, "the MCP server to start");
			const sleep = holdPid(marker);
			assert.ok(isRunning(sleep), "the subagent's command is running");
			const r = await w.tool("agent_stop", { id });
			assert.equal(r.isError, false, r.text);
			assert.equal(r.details.state, "stopped");
			assert.equal(w.mcp.running().length, 0, "no MCP fixture process is left");
			assert.equal(isRunning(sleep), false, "the subagent's command was killed");
			assert.equal((await statusOf(w, id)).state, "stopped");
			await new Promise((res) => setTimeout(res, 300));
			assert.equal(w.parentNotices.length, 0, "stopping sends no finish notice");
			const again = await w.tool("agent_send", { id, message: "hello?" });
			assert.equal(again.isError, true);
			assert.match(again.text, /was stopped/);
		} finally {
			await w.close();
		}
	});
});

describe("agent_status", () => {
	test("reports state, turn and last activity for one id and for all", async () => {
		const w = await createWorld();
		try {
			const gate = join(w.root, "gate-status");
			const done = await launch(w, "OK finished", "the quick one");
			await waitFor(() => w.parentNotices.length === 1, "the first subagent to finish");
			const running = await launch(w, `GATE ${gate}`, "the slow one");
			await waitFor(() => started(gate), "the second subagent to start");

			const one = await w.tool("agent_status", { id: done.id });
			assert.equal(one.isError, false, one.text);
			const [d] = one.details as AgentStatus[];
			assert.equal(d.id, done.id);
			assert.equal(d.state, "idle");
			assert.equal(d.turn, 1);
			assert.equal(d.lastActivity, "finished");
			assert.ok(!Number.isNaN(Date.parse(d.lastActivityAt)));
			assert.equal(d.backend, "in-process");
			assert.match(one.text, new RegExp(`${done.id} \\[in-process\\] idle: turn 1`));

			const all = await w.tool("agent_status", {});
			const byId = new Map((all.details as AgentStatus[]).map((s) => [s.id, s]));
			assert.deepEqual([...byId.keys()].sort(), [done.id, running.id].sort());
			const r = byId.get(running.id)!;
			assert.equal(r.state, "running");
			assert.equal(r.lastActivity, "tool bash");
			assert.equal(r.toolCalls, 1);
			assert.match(all.text, /the slow one|general-purpose/);
			release(gate);
			await waitFor(() => w.parentNotices.length === 2, "the second subagent to finish");
		} finally {
			await w.close();
		}
	});

	test("with nothing started it says so", async () => {
		const w = await createWorld();
		try {
			const r = await w.tool("agent_status", {});
			assert.equal(r.isError, false);
			assert.match(r.text, /No background subagents/);
		} finally {
			await w.close();
		}
	});
});

describe("unknown ids", () => {
	test("give a clear error on agent_send, agent_stop and agent_status", async () => {
		const w = await createWorld();
		try {
			const { id } = await launch(w, "OK hi");
			for (const [name, args] of [
				["agent_send", { id: "nope-12345", message: "x" }],
				["agent_stop", { id: "nope-12345" }],
				["agent_status", { id: "nope-12345" }],
			] as const) {
				const r = await w.tool(name, args);
				assert.equal(r.isError, true, name);
				assert.match(r.text, /Unknown subagent id "nope-12345"/, name);
				assert.match(r.text, new RegExp(`Known ids: ${id}`), name);
			}
		} finally {
			await w.close();
		}
	});
});

describe("the concurrency cap", () => {
	test("a background subagent holds a slot while it runs, and the next one queues", async () => {
		const saved = process.env.SUBAGENT_CONCURRENCY;
		process.env.SUBAGENT_CONCURRENCY = "1";
		const w = await createWorld();
		try {
			const gate = join(w.root, "gate-cap");
			const a = await launch(w, `GATE ${gate}`, "holds the slot");
			await waitFor(() => started(gate), "the first subagent to start");
			const b = await launch(w, "OK second", "waits");
			assert.equal((await statusOf(w, b.id)).state, "queued");
			const early = await w.tool("agent_send", { id: b.id, message: "hi" });
			assert.equal(early.isError, true);
			assert.match(early.text, /queued/);
			release(gate);
			await waitFor(() => w.parentNotices.length === 2, "both to finish");
			assert.equal((await statusOf(w, a.id)).state, "idle");
			assert.equal((await statusOf(w, b.id)).state, "idle");
		} finally {
			if (saved === undefined) delete process.env.SUBAGENT_CONCURRENCY;
			else process.env.SUBAGENT_CONCURRENCY = saved;
			await w.close();
		}
	});
});

describe("orchestrator shutdown", () => {
	test("tears down its background subagents and leaves no MCP process", async () => {
		const w = await createWorld({ mcp: true });
		try {
			const marker = join(w.root, "bg-shutdown");
			const gate = join(w.root, "gate-shutdown");
			const a = await launch(w, `HOLD ${marker}`, "one");
			const b = await launch(w, `GATE ${gate}`, "two");
			await waitFor(() => existsSync(marker) && started(gate), "both subagents to be mid-turn");
			await waitFor(() => w.mcp.running().length >= 2, "both MCP servers to start");
			// what pi's runtime does when the orchestrator exits
			await w.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			assert.equal(w.mcp.running().length, 0, "no MCP fixture process survives");
			assert.equal(isRunning(holdPid(marker)), false, "the subagent's command was killed");
			assert.equal(w.parentNotices.length, 0, "no notices from a shutdown");
			const r = await w.tool("agent_status", { id: a.id });
			assert.equal(r.isError, true, "the registry is empty afterwards");
			void b;
		} finally {
			await w.close();
		}
	});
});

describe("no nesting", () => {
	test("a background subagent has none of agent, agent_send, agent_stop, agent_status", async () => {
		const w = await createWorld();
		try {
			const parent = await w.tool("agent_status", {}); // the parent offers the control tools
			assert.equal(parent.isError, false);
			for (const t of ["agent", "agent_send", "agent_stop", "agent_status"]) assert.ok(w.parentToolNames.at(-1)!.includes(t), `the parent has ${t}`);
			await launch(w, "TOOLS");
			await waitFor(() => w.parentNotices.length === 1, "the finish notice");
			const tools: string[] = JSON.parse(w.parentNotices[0].split("\n\n").slice(1).join("\n\n"));
			for (const t of ["agent", "agent_send", "agent_stop", "agent_status"]) assert.ok(!tools.includes(t), `the subagent has no ${t}`);
		} finally {
			await w.close();
		}
	});
});

describe("the registry (the contract both backends implement)", () => {
	function fakeBackend(name: "in-process" | "herdr", log: string[]): AgentBackend {
		const finish = new Map<string, (r: any) => void>();
		const mk = (id: string): AgentStatus => ({ id, type: "t", description: "d", backend: name, state: "running", turn: 0, lastActivity: "x", lastActivityAt: new Date().toISOString(), toolCalls: 0, tokens: 0 });
		return {
			name,
			async start(spec) {
				log.push(`${name}:start:${spec.id}`);
				return name === "herdr" ? { address: "term-7" } : {};
			},
			async send(id, m) {
				log.push(`${name}:send:${id}:${m}`);
				return "steered";
			},
			async stop(id) {
				log.push(`${name}:stop:${id}`);
			},
			status: mk,
			onFinish(id, cb) {
				finish.set(id, cb);
			},
		};
	}

	test("routes send, stop and status to the backend that started the id, and reports its address", async () => {
		const log: string[] = [];
		const a = fakeBackend("in-process", log);
		const h = fakeBackend("herdr", log);
		let pick = a;
		const reg = new AgentRegistry(() => pick);
		const spec: any = { agentType: "Explore", description: "d", prompt: "p" };
		const first = await reg.launch(spec, () => {});
		pick = h;
		const second = await reg.launch(spec, () => {});
		assert.equal(first.backend, "in-process");
		assert.equal(second.backend, "herdr");
		assert.equal(second.address, "term-7");
		assert.match(first.id, /^explore-[a-z0-9]{5}$/);
		await reg.send(first.id, "m1");
		await reg.send(second.id, "m2");
		await reg.stop(second.id);
		assert.deepEqual(log, [`in-process:start:${first.id}`, `herdr:start:${second.id}`, `in-process:send:${first.id}:m1`, `herdr:send:${second.id}:m2`, `herdr:stop:${second.id}`]);
		assert.deepEqual(reg.status().map((s) => s.backend), ["in-process", "herdr"]);
		await reg.stopAll();
		assert.ok(log.includes(`in-process:stop:${first.id}`));
	});

	test("ids are unique, even when the random part collides", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 500; i++) {
			const id = newAgentId("general-purpose", (x) => seen.has(x));
			assert.ok(!seen.has(id));
			seen.add(id);
		}
		assert.match(newAgentId("My Agent!", () => false), /^my-agent-[a-z0-9]{5}$/);
	});
});

describe("agent_stop during child setup", () => {
	test("agent_stop while the session is being set up never starts the task", async () => {
		const w = await createWorld({ mcp: true });
		try {
			const gate = join(w.root, "gate-x");
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt: `GATE ${gate}`, run_in_background: true });
			const id = r.details.id;
			const stopped = await w.tool("agent_stop", { id });
			assert.equal(stopped.isError, false, stopped.text);
			await sleep(500);
			assert.ok(!existsSync(`${gate}.started`), "the child must not have started work");
			assert.equal(w.childCount(), 0);
			assert.equal((await w.tool("agent_status", { id })).details[0].state, "stopped");
			assert.deepEqual(w.mcp.running(), []);
		} finally {
			await w.close();
		}
	});
});

describe("agent_send racing agent_stop", () => {
	test("a send then a stop in one batch: the stopped subagent never runs again", async () => {
		const w = await createWorld();
		try {
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt: "OK first", run_in_background: true });
			const id = r.details.id;
			await waitFor(() => w.parentNotices.length === 1, "first notice");
			const run = w.startTools([
				{ name: "agent_send", args: { id, message: "OK second" } },
				{ name: "agent_stop", args: { id } },
			]);
			await run.done;
			await sleep(1500);
			assert.equal((await w.tool("agent_status", { id })).details[0].state, "stopped");
			assert.equal(w.parentNotices.length, 1, "no finish notice from the aborted run");
			assert.equal(w.childCount(), 1, "no second child ran the follow-up");
		} finally {
			await w.close();
		}
	});

	test("a stop then a send in one batch: the send is refused", async () => {
		const w = await createWorld();
		try {
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt: "OK first", run_in_background: true });
			const id = r.details.id;
			await waitFor(() => w.parentNotices.length === 1, "first notice");
			const run = w.startTools([
				{ name: "agent_stop", args: { id } },
				{ name: "agent_send", args: { id, message: "OK second" } },
			]);
			await run.done;
			const [, sent] = run.results();
			assert.equal(sent.isError, true);
			assert.match(sent.text, /stopped/);
			assert.equal(w.childCount(), 1);
		} finally {
			await w.close();
		}
	});

	test("two parallel sends to one idle subagent run one child, not two", async () => {
		const w = await createWorld({ persist: true });
		try {
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt: "OK first", run_in_background: true });
			const id = r.details.id;
			await waitFor(() => w.parentNotices.length === 1, "first notice");
			const gate = join(w.root, "gate-two");
			const run = w.startTools([
				{ name: "agent_send", args: { id, message: `GATE ${gate}` } },
				{ name: "agent_send", args: { id, message: "OK third" } },
			]);
			await run.done;
			const results = run.results();
			assert.equal(results.filter((x) => !x.isError).length, 1, JSON.stringify(results.map((x) => x.text)));
			writeFileSync(`${gate}.go`, "");
		} finally {
			await w.close();
		}
	});
});

describe("background subagents survive a session change", () => {
	for (const reason of ["new", "resume", "fork", "reload"] as const) {
		test(`${reason}: the finish notice reaches the new session, and the control tools find the subagent`, async () => {
			const w = await createWorld();
			const gate = join(w.root, `gate-${reason}`);
			try {
				const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt: `GATE ${gate}`, run_in_background: true });
				const id = r.details.id as string;
				await waitFor(() => existsSync(`${gate}.started`), "child running");
				const old = w.session;
				await w.switchSession(reason);
				assert.notEqual(w.session, old);
				const s = await w.tool("agent_status", { id });
				assert.equal(s.isError, false, s.text);
				assert.equal(s.details[0].state, "running");
				writeFileSync(`${gate}.go`, "");
				await waitFor(() => w.parentNotices.length === 1, "finish notice in the new session");
				assert.match(w.parentNotices[0], new RegExp(`${id}.*finished`));
				const entry: any = w.session.sessionManager.getEntries().findLast((e: any) => e.type === "custom_message");
				assert.ok(entry, "the notice is in the new session");
				assert.equal((await w.tool("agent_status", { id })).details[0].state, "idle");
			} finally {
				await w.close();
			}
		});
	}

	test("agent_stop works across a session change", async () => {
		const w = await createWorld();
		try {
			const hold = join(w.root, "hold");
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt: `HOLD ${hold}`, run_in_background: true });
			await waitFor(() => existsSync(hold), "child running");
			await w.switchSession("new");
			const stopped = await w.tool("agent_stop", { id: r.details.id });
			assert.equal(stopped.isError, false, stopped.text);
			assert.equal(stopped.details.state, "stopped");
		} finally {
			await w.close();
		}
	});

	test("quit still stops everything and removes clean worktrees", async () => {
		const w = await createWorld({ git: true });
		try {
			const hold = join(w.root, "hold");
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt: `HOLD ${hold}`, isolation: "worktree", run_in_background: true });
			await waitFor(() => existsSync(hold), "child running");
			await w.switchSession("new");
			assert.ok(existsSync(r.details.worktree.path), "kept running through the change");
			await w.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			assert.ok(!existsSync(r.details.worktree.path), "clean worktree removed on quit");
			assert.deepEqual((await w.tool("agent_status", {})).details, []);
		} finally {
			await w.close();
		}
	});
});
