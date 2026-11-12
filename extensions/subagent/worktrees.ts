// `isolation: "worktree"`: a subagent works in its own git worktree, cut from the orchestrator's HEAD
// on a new branch `agent/<id>` (the id is `<type>-<shortid>`, see `newAgentId` in backend.ts).
//
// The directory is `<state dir>/worktrees/<repo>-<hash>/<id>`. git-guard's commit rule
// (extensions/git-guard/index.ts) decides whether `git_commit` is free by checking that the repo root is under
// `<state dir>/worktrees/`, with the same state dir: `$SUBAGENT_STATE_DIR`, else `~/.local/state/subagent`.
// It does not read `$XDG_STATE_HOME`, so neither does this module (the transcript fallback in transcripts.ts does).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

export interface Worktree {
	/** The worktree's root. */
	path: string;
	/** Where the subagent runs: the same subdirectory of the worktree as the orchestrator's cwd is of the repo. */
	cwd: string;
	branch: string;
	/** The commit it was cut from. */
	base: string;
	/** The orchestrator's repository root. */
	repo: string;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	/** Kept only because it holds ignored files (build output, notes): no commits, no tracked or untracked changes. */
	ignoredOnly?: boolean;
}

/** Must agree with git-guard's `commitIsFree`. */
export function subagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.SUBAGENT_STATE_DIR || join(homedir(), ".local", "state", "subagent");
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitError(e: unknown): string {
	const err = e as { stderr?: Buffer | string; message?: string };
	return (err.stderr?.toString().trim() || err.message || String(e)).split("\n")[0];
}

/** `agent/<id>`: the id is already a lowercase slug, so this is a valid ref. */
export const branchFor = (id: string) => `agent/${id}`;

/** Create the worktree for subagent `id`. Throws a clear error when `cwd` is not in a git repository with a commit. */
export function createWorktree(o: { cwd: string; id: string; env?: NodeJS.ProcessEnv }): Worktree {
	let repo: string;
	let base: string;
	try {
		repo = realpathSync(git(o.cwd, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new Error(`isolation: "worktree" needs the working directory to be inside a git repository, and ${o.cwd} is not.`);
	}
	try {
		base = git(repo, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		throw new Error(`isolation: "worktree" needs a commit to start from, and the repository at ${repo} has none.`);
	}
	const hash = createHash("sha1").update(repo).digest("hex").slice(0, 8);
	const parent = join(subagentStateDir(o.env), "worktrees", `${basename(repo)}-${hash}`);
	const path = join(parent, o.id);
	const branch = branchFor(o.id);
	mkdirSync(parent, { recursive: true });
	try {
		git(repo, ["worktree", "add", "-b", branch, path, base]);
	} catch (e) {
		throw new Error(`Could not create the worktree for the subagent: ${gitError(e)}`);
	}
	const sub = relative(repo, realpathSync(o.cwd));
	// The orchestrator's subdirectory may be untracked or ignored, so absent from the checkout.
	const cwd = sub && existsSync(join(path, sub)) ? join(path, sub) : path;
	return { path, cwd, branch, base, repo };
}

/** Put a worktree that finishing removed back, at the same path and branch, from the same base. */
export function restoreWorktree(wt: Worktree): void {
	if (existsSync(wt.path)) return;
	try {
		git(wt.repo, ["worktree", "prune"]);
		git(wt.repo, ["worktree", "add", "-b", wt.branch, wt.path, wt.base]);
	} catch (e) {
		throw new Error(`Could not recreate the subagent's worktree: ${gitError(e)}`);
	}
}

/** The `<repo>-<hash>` folder goes with its last worktree; rmdir refuses a folder that still holds one. */
function removeIfEmpty(dir: string): void {
	try {
		rmdirSync(dir);
	} catch {
		// Not empty, or already gone.
	}
}

/**
 * The subagent finished. A worktree with no commits beyond its base and a clean tree goes away with its
 * branch (only that branch); anything else stays, and the caller reports it. Never forces: if git refuses to
 * remove it, it is kept.
 */
export function finishWorktree(wt: Worktree): { removed: true } | { removed: false; info: WorktreeInfo } {
	const keep = { removed: false as const, info: { path: wt.path, branch: wt.branch } };
	try {
		if (!existsSync(wt.path)) {
			// Removed by hand: only the branch may be left.
			git(wt.repo, ["worktree", "prune"]);
			removeIfEmpty(dirname(wt.path));
			return { removed: true };
		}
		const head = git(wt.path, ["rev-parse", "--verify", "HEAD"]);
		// Ignored files count: removing the worktree would delete them (notes, .env, build output).
		const dirty = git(wt.path, ["status", "--porcelain", "--untracked-files=all"]) !== "";
		const ignored = git(wt.path, ["status", "--porcelain", "--ignored", "--untracked-files=all"]) !== "";
		const branchHead = git(wt.repo, ["rev-parse", "--verify", `refs/heads/${wt.branch}`]);
		if (dirty || head !== wt.base || branchHead !== wt.base) return keep;
		if (ignored) return { removed: false, info: { ...keep.info, ignoredOnly: true } };
		git(wt.repo, ["worktree", "remove", wt.path]);
		git(wt.repo, ["branch", "-D", wt.branch]);
		removeIfEmpty(dirname(wt.path));
		return { removed: true };
	} catch {
		return keep;
	}
}

/** The sentence a result or notice appends when the worktree was kept, or "" when there is none. */
export function worktreeNote(info: WorktreeInfo | undefined, inUse = false): string {
	if (info && inUse) return `\n\nWorktree in use by the subagent's open terminal: ${info.path} on branch ${info.branch}. It is checked when the subagent is stopped.`;
	if (info?.ignoredOnly) return `\n\nWorktree kept: only ignored files (e.g. build output): ${info.path} on branch ${info.branch}.`;
	return info ? `\n\nWorktree kept (it has changes or commits): ${info.path} on branch ${info.branch}.` : "";
}
