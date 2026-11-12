// Worktree isolation: `isolation: "worktree"` on foreground, in-process background and Herdr subagents.
// Every test repo is a throwaway in a temp dir, and SUBAGENT_STATE_DIR points into the same temp dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createWorld, waitFor, type World } from "./harness.ts";
import { createWorktree, finishWorktree, subagentStateDir, worktreeNote } from "../../extensions/subagent/worktrees.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8" }).trim();
const commit = "git -c user.name=a -c user.email=a@a.invalid commit -q -am work";
const branches = (cwd: string) => git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
const agentBranches = (cwd: string) => branches(cwd).filter((b) => b.startsWith("agent/"));
const listed = (w: World) => git(w.cwd, "worktree", "list", "--porcelain");

describe("a foreground subagent with isolation: worktree", () => {
	let w: World;
	before(async () => {
		w = await createWorld({ git: true });
	});
	after(() => w.close());

	test("works in a new worktree on agent/<type>-<id>, cut from HEAD, and leaves the orchestrator's tree alone", async () => {
		writeFileSync(join(w.cwd, "dirty.txt"), "uncommitted");
		const head = git(w.cwd, "rev-parse", "HEAD");
		const { results } = await w.run([{ description: "edit", prompt: "BASH pwd && git branch --show-current && git rev-parse HEAD && ls && echo changed > new.txt", isolation: "worktree" }]);
		const r = results[0];
		assert.equal(r.isError, false, r.text);
		const [pwd, branch, sha, ...files] = r.text.split("\n");
		// the child's bash output is its tool result, which the scripted model echoes back as its final message
		assert.match(r.details.worktree.path, new RegExp(`^${w.subagentStateDir}/worktrees/project-[0-9a-f]{8}/general-purpose-[a-z0-9]{5}$`));
		assert.equal(pwd, r.details.worktree.path);
		assert.match(branch, /^agent\/general-purpose-[a-z0-9]{5}$/);
		assert.equal(r.details.worktree.branch, branch);
		assert.equal(sha, head);
		assert.ok(!files.includes("dirty.txt"), "uncommitted changes are not carried over");
		// the orchestrator's tree: same branch, same status as before
		assert.equal(git(w.cwd, "status", "--porcelain"), "?? dirty.txt");
		assert.equal(git(w.cwd, "rev-parse", "HEAD"), head);
		assert.ok(!existsSync(join(w.cwd, "new.txt")));
		// it changed something (a new file), so the worktree stays, and the result says where
		assert.match(r.text, /Worktree kept/);
		assert.ok(existsSync(join(r.details.worktree.path, "new.txt")));
	});

	test("a subagent that changed nothing leaves no worktree and no branch", async () => {
		const before = agentBranches(w.cwd);
		const dirs = existsSync(join(w.subagentStateDir, "worktrees")) ? listed(w) : "";
		const { results } = await w.run([{ description: "look", prompt: "OK nothing", isolation: "worktree" }]);
		assert.equal(results[0].isError, false);
		assert.equal(results[0].text, "done: nothing");
		assert.equal(results[0].details.worktree, undefined);
		assert.deepEqual(agentBranches(w.cwd), before);
		assert.equal(listed(w), dirs);
	});

	test("a subagent that committed keeps its worktree and branch, and both are in the result", async () => {
		const { results } = await w.run([{ description: "commit", prompt: `BASH echo more >> README && ${commit}`, isolation: "worktree" }]);
		const wt = results[0].details.worktree;
		assert.ok(wt, results[0].text);
		assert.ok(existsSync(wt.path));
		assert.ok(agentBranches(w.cwd).includes(wt.branch));
		assert.notEqual(git(wt.path, "rev-parse", "HEAD"), git(w.cwd, "rev-parse", "HEAD"));
		assert.match(results[0].text, new RegExp(`${wt.path} on branch ${wt.branch}`));
	});

	test("two parallel subagents get separate worktrees", async () => {
		const { results } = await w.run([
			{ description: "a", prompt: "BASH echo a > a.txt", isolation: "worktree" },
			{ description: "b", prompt: "BASH echo b > b.txt", isolation: "worktree" },
		]);
		const [a, b] = results.map((r) => r.details.worktree);
		assert.notEqual(a.path, b.path);
		assert.ok(existsSync(join(a.path, "a.txt")) && !existsSync(join(a.path, "b.txt")));
		assert.ok(existsSync(join(b.path, "b.txt")) && !existsSync(join(b.path, "a.txt")));
	});

	test("without the option the subagent runs in the orchestrator's directory", async () => {
		const { results } = await w.run([{ description: "plain", prompt: "BASH pwd" }]);
		assert.equal(results[0].text, w.cwd);
		assert.equal(results[0].details.worktree, undefined);
	});

	test("the worktree location agrees with git-guard: under $SUBAGENT_STATE_DIR/worktrees, and not moved by XDG_STATE_HOME", () => {
		assert.equal(subagentStateDir({ SUBAGENT_STATE_DIR: "/x/y", XDG_STATE_HOME: "/z" }), "/x/y");
		assert.equal(subagentStateDir({ XDG_STATE_HOME: "/z" }), join(process.env.HOME!, ".local/state/subagent"));
	});
});

describe("isolation: worktree outside a git repository", () => {
	test("fails with a clear error and starts no subagent", async () => {
		const w = await createWorld();
		try {
			const { results } = await w.run([{ description: "x", prompt: "OK hi", isolation: "worktree" }]);
			assert.equal(results[0].isError, true);
			assert.match(results[0].text, /needs the working directory to be inside a git repository/);
			const bg = await w.tool("agent", { subagent_type: "general-purpose", description: "x", prompt: "OK hi", isolation: "worktree", run_in_background: true });
			assert.equal(bg.isError, true);
			assert.match(bg.text, /git repository/);
			assert.equal(w.childCount(), 0);
			assert.equal((await w.tool("agent_status", {})).text, "No background subagents.");
		} finally {
			await w.close();
		}
	});

	test("a repository with no commit has a clear error too", async () => {
		const w = await createWorld();
		try {
			execFileSync("git", ["init", "-q"], { cwd: w.cwd });
			assert.throws(() => createWorktree({ cwd: w.cwd, id: "x-abcde", env: { SUBAGENT_STATE_DIR: w.subagentStateDir } }), /has none/);
		} finally {
			await w.close();
		}
	});
});

describe("a background subagent in-process with isolation: worktree", () => {
	let w: World;
	before(async () => {
		w = await createWorld({ git: true });
	});
	after(() => w.close());

	const launch = async (prompt: string) => {
		const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt, isolation: "worktree", run_in_background: true });
		assert.equal(r.isError, false, r.text);
		return r;
	};
	const finished = async (n: number) => waitFor(() => w.parentNotices.length >= n, "the finish notice");

	test("runs in its worktree while running; a clean one is removed on finish, with its branch", async () => {
		const gate = join(w.root, "g1");
		const r = await launch(`GATE ${gate}`);
		const wt = r.details.worktree;
		assert.match(wt.branch, /^agent\/general-purpose-[a-z0-9]{5}$/);
		assert.equal(wt.branch, `agent/${r.details.id}`);
		assert.match(r.text, new RegExp(`Its worktree: ${wt.path}`));
		await waitFor(() => existsSync(`${gate}.started`), "the subagent to start");
		assert.ok(existsSync(wt.path));
		assert.equal((await w.tool("agent_status", { id: r.details.id })).details[0].worktree.path, wt.path);
		writeFileSync(`${gate}.go`, "");
		await finished(1);
		assert.ok(!existsSync(wt.path), "the clean worktree was removed");
		assert.ok(!agentBranches(w.cwd).includes(wt.branch));
		assert.match(w.parentNotices[0], /finished/);
		assert.doesNotMatch(w.parentNotices[0], /Worktree kept/);
		assert.equal((await w.tool("agent_status", { id: r.details.id })).details[0].worktree, undefined);
	});

	test("its cwd is the worktree", async () => {
		const seen = w.parentNotices.length;
		const r = await launch("BASH pwd");
		await finished(seen + 1);
		// pwd output is the child's final message; the worktree has no changes, so it is gone but the path was its cwd
		assert.ok(w.parentNotices.at(-1)!.includes(r.details.worktree.path));
	});

	test("one with changes keeps its worktree: path and branch in the notice and in agent_status", async () => {
		const seen = w.parentNotices.length;
		const r = await launch("BASH echo hi > f.txt");
		const wt = r.details.worktree;
		await finished(seen + 1);
		const notice = w.parentNotices.at(-1)!;
		assert.match(notice, new RegExp(`Worktree kept.*${wt.path} on branch ${wt.branch}`));
		assert.ok(existsSync(join(wt.path, "f.txt")));
		const st = (await w.tool("agent_status", { id: r.details.id })).details[0];
		assert.deepEqual(st.worktree, wt);
	});

	test("a continuation after a clean finish still runs: the worktree is put back for it", async () => {
		const seen = w.parentNotices.length;
		const r = await launch("OK first");
		await finished(seen + 1);
		assert.ok(!existsSync(r.details.worktree.path));
		const send = await w.tool("agent_send", { id: r.details.id, message: "again" });
		assert.equal(send.isError, false, send.text);
		await finished(seen + 2);
		assert.match(w.parentNotices.at(-1)!, /finished\.\n\ncontinued: again/);
		// nothing changed in the continuation either: gone again
		assert.ok(!existsSync(r.details.worktree.path));
		assert.ok(!agentBranches(w.cwd).includes(r.details.worktree.branch));
	});

	test("agent_stop counts as a finish: a clean worktree goes, one with changes stays", async () => {
		const clean = await launch(`HOLD ${join(w.root, "hold-clean")}`);
		const dirty = await launch(`BASH echo x > x.txt && sleep 300`);
		await waitFor(() => existsSync(join(w.root, "hold-clean")), "the HOLD child to start");
		await waitFor(() => existsSync(join(dirty.details.worktree.path, "x.txt")), "the dirty child's edit");
		const a = await w.tool("agent_stop", { id: clean.details.id });
		assert.equal(a.details.worktree, undefined);
		assert.ok(!existsSync(clean.details.worktree.path));
		assert.ok(!agentBranches(w.cwd).includes(clean.details.worktree.branch));
		const b = await w.tool("agent_stop", { id: dirty.details.id });
		assert.deepEqual(b.details.worktree, dirty.details.worktree);
		assert.match(b.text, /worktree .* on branch agent\//);
		assert.ok(existsSync(dirty.details.worktree.path));
	});
});

describe("orchestrator shutdown", () => {
	test("keeps worktrees with changes or commits, removes clean ones", async () => {
		const w = await createWorld({ git: true });
		let kept: any, committed: any, clean: any;
		try {
			const launch = (prompt: string) => w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt, isolation: "worktree", run_in_background: true });
			const mark = (n: string) => join(w.root, n);
			kept = (await launch(`BASH echo x > x.txt && touch ${mark("k")} && sleep 300`)).details.worktree;
			committed = (await launch(`BASH echo y >> README && ${commit} && touch ${mark("c")} && sleep 300`)).details.worktree;
			clean = (await launch(`HOLD ${mark("h")}`)).details.worktree;
			await waitFor(() => ["k", "c", "h"].every((n) => existsSync(mark(n))), "all three to be mid-turn");
		} finally {
			await w.close();
		}
		assert.ok(existsSync(kept.path) && existsSync(join(kept.path, "x.txt")));
		assert.ok(existsSync(committed.path));
		assert.ok(!existsSync(clean.path));
		assert.ok(agentBranches(git(kept.path, "rev-parse", "--show-toplevel") && w.cwd).includes(kept.branch));
		assert.ok(!agentBranches(w.cwd).includes(clean.branch));
	});
});

describe("a Herdr subagent with isolation: worktree", () => {
	let w: World;
	before(async () => {
		w = await createWorld({ herdr: true, persist: true, git: true });
	});
	after(() => w.close());

	test("is launched with the worktree as its working directory; transcript stays with the orchestrator's session", async () => {
		const r = await w.tool("agent", { subagent_type: "general-purpose", description: "h", prompt: "OK herdr", isolation: "worktree", run_in_background: true });
		assert.equal(r.isError, false, r.text);
		assert.equal(r.details.backend, "herdr");
		const wt = r.details.worktree;
		const [run] = w.herdr.calls("run");
		assert.equal(run.cwd, wt.path);
		assert.ok(existsSync(wt.path));
		const argv: string[] = run.argv;
		assert.match(argv[argv.indexOf("--session") + 1], /\.subagents\//);
		assert.ok(!argv[argv.indexOf("--session") + 1].startsWith(w.subagentStateDir));
	});

	test("on finish the worktree stays, reported as in use (the terminal is still open)", async () => {
		const first = await w.tool("agent", { subagent_type: "general-purpose", description: "h2", prompt: "OK two", isolation: "worktree", run_in_background: true });
		const id = first.details.id;
		const seen = w.parentNotices.length;
		w.herdr.finish(id, "all done", 1);
		await waitFor(() => w.parentNotices.length > seen, "the finish notice");
		assert.ok(existsSync(first.details.worktree.path));
		assert.match(w.parentNotices.at(-1)!, /in use/);

		const second = await w.tool("agent", { subagent_type: "general-purpose", description: "h3", prompt: "OK three", isolation: "worktree", run_in_background: true });
		writeFileSync(join(second.details.worktree.path, "edit.txt"), "x");
		const seen2 = w.parentNotices.length;
		w.herdr.finish(second.details.id, "edited", 1);
		await waitFor(() => w.parentNotices.length > seen2, "the second finish notice");
		assert.match(w.parentNotices.at(-1)!, new RegExp(`Worktree in use.*${second.details.worktree.path} on branch ${second.details.worktree.branch}`));
		assert.ok(existsSync(second.details.worktree.path));
	});
});

describe("a Herdr subagent's worktree outlives its finish", () => {
	let w: World;
	before(async () => {
		w = await createWorld({ herdr: true, persist: true, git: true });
	});
	after(() => w.close());
	const launch = (prompt: string) => w.tool("agent", { subagent_type: "general-purpose", description: "h", prompt, isolation: "worktree", run_in_background: true });
	const finish = async (id: string, turn = 1) => {
		const seen = w.parentNotices.length;
		w.herdr.finish(id, "done", turn);
		await waitFor(() => w.parentNotices.length > seen, "the finish notice");
		return w.parentNotices.at(-1)!;
	};

	test("a clean finish leaves the worktree in place and says it is in use; agent_stop then removes it and its branch", async () => {
		const r = await launch("OK clean");
		const wt = r.details.worktree;
		const notice = await finish(r.details.id);
		assert.ok(existsSync(wt.path));
		assert.match(notice, new RegExp(`in use.*${wt.path} on branch ${wt.branch}`));
		assert.deepEqual((await w.tool("agent_status", { id: r.details.id })).details[0].worktree, wt);
		const stop = await w.tool("agent_stop", { id: r.details.id });
		assert.ok(!existsSync(wt.path));
		assert.ok(!agentBranches(w.cwd).includes(wt.branch));
		assert.equal(stop.details.worktree, undefined);
	});

	test("a continuation after finish runs in the same, still-present worktree", async () => {
		const r = await launch("OK again");
		await finish(r.details.id);
		const dirOf = existsSync(r.details.worktree.path);
		const send = await w.tool("agent_send", { id: r.details.id, message: "more" });
		assert.equal(send.isError, false, send.text);
		assert.ok(dirOf && existsSync(r.details.worktree.path));
		assert.equal(w.herdr.calls("run").filter((c) => c.name === r.details.id).length, 1);
		await w.tool("agent_stop", { id: r.details.id });
	});

	test("a dirty one survives stop", async () => {
		const r = await launch("OK dirty");
		writeFileSync(join(r.details.worktree.path, "d.txt"), "x");
		await finish(r.details.id);
		const stop = await w.tool("agent_stop", { id: r.details.id });
		assert.deepEqual(stop.details.worktree, r.details.worktree);
		assert.ok(existsSync(join(r.details.worktree.path, "d.txt")));
	});
});

describe("Herdr children at orchestrator shutdown", () => {
	test("a clean worktree is removed after the terminals are killed, a dirty one stays", async () => {
		const w = await createWorld({ herdr: true, persist: true, git: true });
		let clean: any, dirty: any;
		try {
			const launch = (prompt: string) => w.tool("agent", { subagent_type: "general-purpose", description: "h", prompt, isolation: "worktree", run_in_background: true });
			clean = (await launch("OK a")).details.worktree;
			dirty = (await launch("OK b")).details.worktree;
			writeFileSync(join(dirty.path, "d.txt"), "x");
			assert.ok(existsSync(clean.path));
		} finally {
			await w.close();
		}
		assert.ok(!existsSync(clean.path));
		assert.ok(existsSync(join(dirty.path, "d.txt")));
	});
});

describe("a worktree kept only for ignored files says so", () => {
	const repo = async (): Promise<World> => {
		const w = await createWorld({ git: true });
		writeFileSync(join(w.cwd, ".gitignore"), "target/\n");
		git(w.cwd, "add", ".gitignore");
		git(w.cwd, "commit", "-q", "-m", "ignore");
		return w;
	};

	test("finishWorktree and its note", async () => {
		const w = await repo();
		try {
			const ign = createWorktree({ cwd: w.cwd, id: "general-purpose-aaaaa" });
			mkdirSync(join(ign.path, "target"));
			writeFileSync(join(ign.path, "target/out"), "x");
			const done = finishWorktree(ign);
			assert.ok(!done.removed && done.info.ignoredOnly);
			assert.match(worktreeNote(done.info), /kept: only ignored files \(e\.g\. build output\)/);

			const dirty = createWorktree({ cwd: w.cwd, id: "general-purpose-bbbbb" });
			writeFileSync(join(dirty.path, "new.txt"), "x");
			const d = finishWorktree(dirty);
			assert.ok(!d.removed && !d.info.ignoredOnly);
			assert.match(worktreeNote(d.info), /has changes or commits/);
		} finally {
			await w.close();
		}
	});

	test("the finish notice says it", async () => {
		const w = await repo();
		try {
			await w.tool("agent", { subagent_type: "general-purpose", description: "b", prompt: "BASH mkdir -p target && echo x > target/out", isolation: "worktree", run_in_background: true });
			await waitFor(() => w.parentNotices.length === 1, "finish notice");
			assert.match(w.parentNotices[0], /only ignored files/);
		} finally {
			await w.close();
		}
	});
});

describe("worktree folders and cleanup", () => {
	const repo = async () => {
		const w = await createWorld({ git: true });
		writeFileSync(join(w.cwd, ".gitignore"), ".cache/\n");
		git(w.cwd, "add", ".gitignore");
		git(w.cwd, "commit", "-q", "-m", "ignore");
		return w;
	};

	test("a clean tree with an ignored file is kept, and the file survives", async () => {
		const w = await repo();
		try {
			const wt = createWorktree({ cwd: w.cwd, id: "general-purpose-aaaaa" });
			mkdirSync(join(wt.path, ".cache"));
			writeFileSync(join(wt.path, ".cache/notes.md"), "keep me");
			const done = finishWorktree(wt);
			assert.equal(done.removed, false);
			assert.equal(readFileSync(join(wt.path, ".cache/notes.md"), "utf8"), "keep me");
		} finally {
			await w.close();
		}
	});

	test("removing the last worktree removes its <repo>-<hash> folder", async () => {
		const w = await repo();
		try {
			const a = createWorktree({ cwd: w.cwd, id: "general-purpose-aaaaa" });
			const b = createWorktree({ cwd: w.cwd, id: "general-purpose-bbbbb" });
			const parent = dirname(a.path);
			finishWorktree(a);
			assert.ok(existsSync(parent), "one worktree is still in it");
			finishWorktree(b);
			assert.ok(!existsSync(parent));
		} finally {
			await w.close();
		}
	});

	test("an orchestrator subdirectory missing from the checkout falls back to the worktree root", async () => {
		const w = await repo();
		try {
			const sub = join(w.cwd, ".cache", "deep");
			mkdirSync(sub, { recursive: true });
			const wt = createWorktree({ cwd: sub, id: "general-purpose-ccccc" });
			assert.equal(wt.cwd, wt.path);
			mkdirSync(join(w.cwd, "src"));
			writeFileSync(join(w.cwd, "src/a.txt"), "x");
			git(w.cwd, "add", "src");
			git(w.cwd, "commit", "-q", "-m", "src");
			const wt2 = createWorktree({ cwd: join(w.cwd, "src"), id: "general-purpose-ddddd" });
			assert.equal(wt2.cwd, join(wt2.path, "src"));
		} finally {
			await w.close();
		}
	});

	test("agent_send to a stopped in-process subagent does not recreate its worktree", async () => {
		const w = await repo();
		try {
			const r = await w.tool("agent", { subagent_type: "general-purpose", description: "bg", prompt: "OK clean", isolation: "worktree", run_in_background: true });
			await waitFor(() => w.parentNotices.length === 1, "finish notice");
			const path = r.details.worktree.path;
			assert.ok(!existsSync(path), "clean, so removed at finish");
			await w.tool("agent_stop", { id: r.details.id });
			const s = await w.tool("agent_send", { id: r.details.id, message: "OK again" });
			assert.equal(s.isError, true);
			assert.match(s.text, /stopped/);
			assert.ok(!existsSync(path));
		} finally {
			await w.close();
		}
	});
});
