import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { concurrencyCap } from "../../extensions/subagent/concurrency.ts";
import { createWorld, waitFor, type World } from "./harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("concurrency cap", () => {
	let w: World;
	before(async () => {
		w = await createWorld();
	});
	after(() => w.close());
	afterEach(() => {
		delete process.env.SUBAGENT_CONCURRENCY;
	});

	const gates = (n: number) => Array.from({ length: n }, (_, i) => join(w.root, `gate-${Math.random().toString(36).slice(2)}-${i}`));
	const calls = (paths: string[]) => paths.map((p, i) => ({ description: `job ${i}`, prompt: `GATE ${p}` }));
	const started = (p: string) => existsSync(`${p}.started`);
	const release = (p: string) => writeFileSync(`${p}.go`, "");

	test("with the default cap of 8, nine subagents: eight run, the ninth reports queued and starts when one finishes", async () => {
		const g = gates(9);
		const run = w.start(calls(g));
		await waitFor(() => g.slice(0, 8).every(started), "eight children to start");
		await sleep(500);
		assert.equal(started(g[8]), false, "the ninth has not started");
		assert.ok(run.updates(8).some((d) => d?.status === "queued"), "the ninth reported queued");
		for (let i = 0; i < 8; i++) assert.ok(!run.updates(i).some((d) => d?.status === "queued"), `call ${i} was never queued`);

		release(g[0]);
		await waitFor(() => started(g[8]), "the ninth to start once a slot frees");
		g.forEach(release);
		await run.done;
		assert.ok(run.results().every((r) => !r.isError));
	});

	test("SUBAGENT_CONCURRENCY changes the cap", async () => {
		process.env.SUBAGENT_CONCURRENCY = "2";
		const g = gates(3);
		const run = w.start(calls(g));
		await waitFor(() => g.slice(0, 2).every(started), "two children to start");
		await sleep(400);
		assert.equal(started(g[2]), false, "the third waits at a cap of 2");
		assert.ok(run.updates(2).some((d) => d?.status === "queued"));
		g.forEach(release);
		await run.done;
		assert.ok(run.results().every((r) => !r.isError));
	});

	test("a queued subagent that is aborted leaves the queue without starting", async () => {
		process.env.SUBAGENT_CONCURRENCY = "1";
		const g = gates(2);
		const run = w.start(calls(g));
		await waitFor(() => started(g[0]), "the first child to start");
		await waitFor(() => run.updates(1).some((d) => d?.status === "queued"), "the second to queue");
		await w.abort();
		await run.done;
		assert.equal(started(g[1]), false, "the queued child never started");
		assert.equal(run.results()[1].isError, true);

		// the slot was released and the queue is clean: a new subagent starts at once
		const [p] = gates(1);
		release(p);
		const next = await w.run([{ description: "after", prompt: `GATE ${p}` }]);
		assert.equal(next.results[0].isError, false);
	});

	test("the cap parses SUBAGENT_CONCURRENCY and falls back to 8", () => {
		assert.equal(concurrencyCap({}), 8);
		assert.equal(concurrencyCap({ SUBAGENT_CONCURRENCY: "3" }), 3);
		assert.equal(concurrencyCap({ SUBAGENT_CONCURRENCY: "0" }), 8);
		assert.equal(concurrencyCap({ SUBAGENT_CONCURRENCY: "abc" }), 8);
	});
});
