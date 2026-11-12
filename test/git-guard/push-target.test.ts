import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { addPushableRemote, callTool, head, makeRepo } from "./harness.ts";

const gitOut = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const branches = (bare: string) => gitOut(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").sort();
const commitStaged = (repo: string) =>
	gitOut(repo, "-c", "user.name=Test User", "-c", "user.email=tester@example.test", "commit", "-q", "-m", "Add a thing");

test("a branch that tracks origin/main and is pushed to a fork goes there under its own name", async () => {
	const repo = makeRepo("pr/x");
	addPushableRemote(repo, "origin");
	gitOut(repo, "branch", "-q", "--set-upstream-to=origin/main", "pr/x");
	const fork = addPushableRemote(repo, "fork");
	commitStaged(repo);
	const r = await callTool({ cwd: repo, tool: "git_push", args: { remote: "fork" } });
	assert.equal(r.isError, false, r.text);
	assert.match(r.dialogs[0].title, /^Push 1 commit\(s\) to fork\/pr\/x \(new upstream\)\?$/);
	assert.deepEqual(branches(fork), ["main", "pr/x"]);
	assert.equal(gitOut(fork, "rev-parse", "pr/x"), head(repo));
	assert.equal(gitOut(repo, "rev-parse", "--abbrev-ref", "pr/x@{upstream}"), "fork/pr/x");
});

test("a branch pushed to the remote of its upstream still goes to the upstream branch", async () => {
	const repo = makeRepo("topic");
	const origin = addPushableRemote(repo, "origin");
	gitOut(repo, "branch", "-q", "--set-upstream-to=origin/main", "topic");
	commitStaged(repo);
	const r = await callTool({ cwd: repo, tool: "git_push", args: {} });
	assert.equal(r.isError, false, r.text);
	assert.match(r.dialogs[0].title, /^Push 1 commit\(s\) to origin\/main\?$/);
	assert.deepEqual(branches(origin), ["main"]);
	assert.equal(gitOut(origin, "rev-parse", "main"), head(repo));
});
