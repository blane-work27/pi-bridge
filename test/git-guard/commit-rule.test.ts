import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { callTool, commit, head, makeRepo, worktreeDir } from "./harness.ts";

const gitOut = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("integration/* commits without a dialog", async () => {
	const repo = makeRepo("integration/pi-subagents");
	const before = head(repo);
	const r = await commit(repo);
	assert.equal(r.isError, false, r.text);
	assert.deepEqual(r.dialogs, []);
	assert.notEqual(head(repo), before);
});

test("agent/* inside the subagent worktree directory commits without a dialog", async () => {
	const repo = makeRepo("agent/task-1", `${worktreeDir}/repo-abc123`);
	const before = head(repo);
	const r = await commit(repo);
	assert.equal(r.isError, false, r.text);
	assert.deepEqual(r.dialogs, []);
	assert.notEqual(head(repo), before);
});

for (const branch of ["agent/task-1", "main", "feature/x", "integration", "agentx/y"]) {
	test(`${branch} outside the subagent worktree directory asks`, async () => {
		const repo = makeRepo(branch);
		const before = head(repo);
		const r = await commit(repo);
		assert.equal(r.isError, false, r.text);
		assert.equal(r.dialogs.length, 1);
		assert.match(r.dialogs[0].title, /^Commit as /);
		assert.notEqual(head(repo), before);
	});
}

test("a branch other than agent/* inside the subagent worktree directory asks", async () => {
	const repo = makeRepo("feature/x", `${worktreeDir}/repo-def456`);
	const r = await commit(repo);
	assert.equal(r.dialogs.length, 1);
});

test("a declined dialog on a guarded branch leaves HEAD alone", async () => {
	const repo = makeRepo("main");
	const before = head(repo);
	const r = await commit(repo, "Add a thing", { approve: false });
	assert.equal(r.isError, true);
	assert.match(r.text, /did not approve/);
	assert.equal(head(repo), before);
});

for (const [name, branch, parent] of [
	["integration/*", "integration/x", undefined],
	["agent/* in a subagent worktree", "agent/t", `${worktreeDir}/repo-0a0a0a`],
] as const) {
	test(`an AI-attributed message is refused on ${name}`, async () => {
		const repo = makeRepo(branch, parent);
		const before = head(repo);
		const r = await commit(repo, "Add a thing\n\nCo-authored-by: Someone <a@b.c>");
		assert.equal(r.isError, true);
		assert.match(r.text, /Co-authored-by trailer/);
		assert.equal(head(repo), before);
	});

	test(`a host with no identity is refused on ${name}`, async () => {
		const repo = makeRepo(branch, parent);
		execFileSync("git", ["config", "remote.origin.pushurl", "git@unknown.example.test:a/b.git"], { cwd: repo });
		const before = head(repo);
		const r = await commit(repo);
		assert.equal(r.isError, true);
		assert.match(r.text, /No identity is set for host unknown\.example\.test/);
		assert.equal(head(repo), before);
	});

	test(`a commit made on ${name} carries the user's identity`, async () => {
		const repo = makeRepo(branch, parent);
		const r = await commit(repo);
		assert.equal(r.isError, false, r.text);
		assert.equal(gitOut(repo, "log", "-1", "--format=%an <%ae> / %cn <%ce>"), "Test User <tester@example.test> / Test User <tester@example.test>");
	});

	test(`git_commit works on ${name} in a session with no UI`, async () => {
		const repo = makeRepo(branch, parent);
		const before = head(repo);
		const r = await commit(repo, "Add a thing", { ui: false });
		assert.equal(r.isError, false, r.text);
		assert.notEqual(head(repo), before);
	});
}

test("git_commit on a guarded branch still needs a UI", async () => {
	const repo = makeRepo("main");
	const before = head(repo);
	const r = await commit(repo, "Add a thing", { ui: false });
	assert.equal(r.isError, true);
	assert.match(r.text, /no UI/);
	assert.equal(head(repo), before);
});

for (const cmd of ["git commit -m x", "git push origin HEAD"]) {
	test(`bash \`${cmd}\` is blocked on a free branch`, async () => {
		const repo = makeRepo("integration/x");
		const before = head(repo);
		const r = await callTool({ cwd: repo, tool: "bash", args: { command: cmd } });
		assert.equal(r.isError, true);
		assert.match(r.text, /is blocked in bash/);
		assert.equal(head(repo), before);
	});
}

test("git_push still asks on a free branch", async () => {
	const repo = makeRepo("integration/x");
	const done = await commit(repo);
	assert.equal(done.isError, false, done.text);
	const r = await callTool({ cwd: repo, tool: "git_push", args: {}, approve: false });
	assert.equal(r.dialogs.length, 1);
	assert.match(r.dialogs[0].title, /^Push 2 commit/);
	assert.equal(r.isError, true);
	assert.match(r.text, /did not approve the push/);
});
