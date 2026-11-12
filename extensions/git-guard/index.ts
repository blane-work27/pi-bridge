import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const identitiesFile = join(process.env.PI_CODING_AGENT_DIR || join(here, "..", ".."), "git-identities.json");

const BOILERPLATE: [RegExp, string][] = [
	[/^\s*co-authored-by\s*:/im, "a Co-authored-by trailer"],
	[/generated (with|by) .*(claude|ai|llm|gpt|copilot|cursor|codex|gemini|pi\b)/i, "a 'generated with' line"],
	[/\bclaude code\b|claude\.com\/claude-code|noreply@anthropic\.com/i, "a Claude Code attribution"],
	[/🤖|✨/u, "an AI emoji"],
	[/\b(ai|llm)[- ](generated|assisted|authored)\b/i, "an AI attribution"],
	[/\bas an ai\b|\bi('| a)m an ai\b/i, "AI self-reference"],
	[/^\s*(assisted|generated|written)-by\s*:/im, "an AI trailer"],
];

const NO_PROMPT = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=15",
};

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 30000): string {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const k of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER)_/.test(k)) delete env[k];
	Object.assign(env, NO_PROMPT, extraEnv);
	return execFileSync("git", args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args).trim();
	} catch {
		return undefined;
	}
}

function hostOf(url: string): string {
	const m = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)/i) || url.match(/^(?:[^@]+@)?([^:/]+):/);
	return (m?.[1] ?? "").toLowerCase();
}

interface Identity {
	name: string;
	email: string;
	host: string;
	remote: string;
	url: string;
}

function loadMap(): Record<string, string> {
	try {
		const raw = JSON.parse(readFileSync(identitiesFile, "utf8"));
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k.toLowerCase()] = v;
		return out;
	} catch (e: any) {
		throw new Error(`Cannot read ${identitiesFile}: ${e.message}. Copy git-identities.example.json to git-identities.json and set your emails.`);
	}
}

function resolveIdentity(root: string, remoteArg?: string): Identity {
	const name = tryGit(root, ["config", "--global", "user.name"]);
	if (!name) throw new Error("git config --global user.name is not set.");
	const branch = tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const remote =
		remoteArg ||
		(branch && tryGit(root, ["config", `branch.${branch}.pushRemote`])) ||
		tryGit(root, ["config", "remote.pushDefault"]) ||
		(branch && tryGit(root, ["config", `branch.${branch}.remote`])) ||
		"origin";
	const url = tryGit(root, ["remote", "get-url", "--push", remote]);
	if (!url) throw new Error(`The repository has no remote named ${remote}. Add one before you commit, so the identity can be chosen.`);
	const host = hostOf(url);
	const email = loadMap()[host];
	if (!email) throw new Error(`No identity is set for host ${host} (remote ${remote}). Add it to ${identitiesFile}.`);
	return { name, email, host, remote, url };
}

function boilerplate(message: string): string[] {
	return BOILERPLATE.filter(([re]) => re.test(message)).map(([, what]) => what);
}

function repoRoot(cwd: string): string {
	const r = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!r) throw new Error(`${cwd} is not in a git repository.`);
	return r;
}

// Commits need no dialog on integration/*, and on agent/* inside a subagent worktree.
function commitIsFree(root: string): boolean {
	const branch = tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!branch) return false;
	if (branch.startsWith("integration/")) return true;
	if (!branch.startsWith("agent/")) return false;
	try {
		const stateDir = process.env.SUBAGENT_STATE_DIR || join(homedir(), ".local", "state", "subagent");
		return realpathSync(root).startsWith(realpathSync(join(stateDir, "worktrees")) + sep);
	} catch {
		return false;
	}
}

function blocks(command: string): string | undefined {
	const segments = command.split(/&&|\|\||;|\||\n|\$\(|`/);
	for (const seg of segments) {
		const words = seg.trim().split(/\s+/);
		const g = words.findIndex((w) => /(^|\/)git$/.test(w));
		if (g < 0) continue;
		let i = g + 1;
		while (i < words.length && words[i].startsWith("-")) {
			if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(words[i])) i++;
			i++;
		}
		const sub = words[i];
		if (sub === "commit" || sub === "push") return sub;
		if (sub === "commit-tree" || sub === "send-pack" || sub === "send-email") return sub;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const cmd = String((event.input as any)?.command ?? "");
		const sub = blocks(cmd);
		if (sub) {
			return {
				block: true,
				reason: `git ${sub} is blocked in bash. Use the git_commit tool to commit and the git_push tool to push. Both ask the user first.`,
			};
		}
	});

	pi.registerTool(
		defineTool({
			name: "git_commit",
			label: "git commit",
			description:
				"Commit the staged changes with a message the user approved. The author and committer are the user's global user.name and the email set for the push remote's host; repo-local identity is ignored. Messages with AI attribution are refused. The user must confirm in a dialog, except on integration/* branches and on agent/* branches in a subagent worktree. Read the commit skill first.",
			promptSnippet: "Commit staged changes after the user approves the message",
			parameters: Type.Object({
				message: Type.String({ description: "The full commit message: subject line, blank line, optional body." }),
				cwd: Type.Optional(Type.String()),
			}),
			executionMode: "sequential",
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const root = repoRoot(params.cwd || ctx.cwd);
				const message = params.message.replace(/\r\n/g, "\n").trim();
				if (!message) throw new Error("The commit message is empty.");
				const bad = boilerplate(message);
				if (bad.length) throw new Error(`The message contains ${bad.join(", ")}. Remove it.`);
				const id = resolveIdentity(root);
				const staged = git(root, ["diff", "--cached", "--stat"]).trim();
				if (!staged) throw new Error("Nothing is staged. Stage the files the user agreed to, then call git_commit again.");
				if (!commitIsFree(root)) {
					if (!ctx.hasUI) throw new Error("git_commit needs a user to confirm, and this session has no UI.");
					const ok = await ctx.ui.confirm(
						`Commit as ${id.name} <${id.email}>?`,
						`Remote: ${id.remote} (${id.host})\n\n${message}\n\n${staged}`,
					);
					if (!ok) throw new Error("The user did not approve the commit. Ask what to change.");
				}
				const tmp = mkdtempSync(join(tmpdir(), "git-guard-"));
				try {
					const file = join(tmp, "MSG");
					writeFileSync(file, `${message}\n`);
					git(root, ["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "commit", "--cleanup=strip", "-F", file], {
						GIT_AUTHOR_NAME: id.name,
						GIT_AUTHOR_EMAIL: id.email,
						GIT_COMMITTER_NAME: id.name,
						GIT_COMMITTER_EMAIL: id.email,
					});
				} finally {
					rmSync(tmp, { recursive: true, force: true });
				}
				const [an, ae, cn, ce, sha] = git(root, ["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce%x00%H"]).trim().split("\0");
				const body = git(root, ["log", "-1", "--format=%B"]);
				const problems: string[] = [];
				if (an !== id.name || cn !== id.name || ae !== id.email || ce !== id.email) problems.push(`identity is ${an} <${ae}> / ${cn} <${ce}>`);
				const after = boilerplate(body);
				if (after.length) problems.push(`a hook added ${after.join(", ")}`);
				if (problems.length) {
					throw new Error(`Commit ${sha.slice(0, 10)} was made, but ${problems.join(" and ")}. Do not push it. Tell the user; the commit is local only.`);
				}
				return {
					content: [{ type: "text", text: `Committed ${sha.slice(0, 10)} as ${id.name} <${id.email}>.` }],
					details: { sha, name: id.name, email: id.email },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "git_push",
			label: "git push",
			description:
				"Push the current branch after the user asks to push. Before pushing, every outgoing commit must have the user's name and the email for the remote's host as author and committer, with no AI attribution in its message. Never forces. The user must confirm in a dialog.",
			promptSnippet: "Push the current branch after checking every outgoing commit",
			parameters: Type.Object({
				remote: Type.Optional(Type.String()),
				cwd: Type.Optional(Type.String()),
			}),
			executionMode: "sequential",
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const root = repoRoot(params.cwd || ctx.cwd);
				const id = resolveIdentity(root, params.remote);
				const branch = tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
				if (!branch) throw new Error("HEAD is detached. Check out a branch first.");
				tryGit(root, ["fetch", "--quiet", id.remote]);
				// The upstream counts only when it is on the remote being pushed to. A branch that tracks origin/main and
				// is pushed to a fork goes there under its own name, as a new upstream.
				const upstream =
					tryGit(root, ["config", `branch.${branch}.remote`]) === id.remote
						? tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`])
						: undefined;
				const range = upstream ? ["HEAD", `^${upstream}`] : ["HEAD", "--not", `--remotes=${id.remote}`];
				const log = git(root, ["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%s", ...range]).trim();
				if (!log) throw new Error(`There is nothing to push on ${branch}.`);
				const lines = log.split("\n");
				const problems: string[] = [];
				for (const line of lines) {
					const [sha, an, ae, cn, ce] = line.split("\0");
					if (an !== id.name || cn !== id.name || ae !== id.email || ce !== id.email) {
						problems.push(`${sha.slice(0, 10)} is by ${an} <${ae}>, committed by ${cn} <${ce}>`);
					}
					const bad = boilerplate(git(root, ["log", "-1", "--format=%B", sha]));
					if (bad.length) problems.push(`${sha.slice(0, 10)} has ${bad.join(", ")}`);
				}
				if (problems.length) {
					throw new Error(`Push refused. Every outgoing commit must be by ${id.name} <${id.email}> with no AI attribution:\n${problems.join("\n")}`);
				}
				if (upstream) {
					const behind = tryGit(root, ["rev-list", "--count", `HEAD..${upstream}`]);
					if (behind && behind !== "0") throw new Error(`${branch} is ${behind} commits behind ${upstream}. Push refused, because it would need a force push. Tell the user.`);
				}
				if (!ctx.hasUI) throw new Error("git_push needs a user to confirm, and this session has no UI.");
				const summary = lines.map((l) => {
					const [sha, , , , , subject] = l.split("\0");
					return `${sha.slice(0, 10)} ${subject}`;
				});
				const target = upstream ? upstream : `${id.remote}/${branch} (new upstream)`;
				const ok = await ctx.ui.confirm(`Push ${lines.length} commit(s) to ${target}?`, `As ${id.name} <${id.email}> to ${id.url}\n\n${summary.join("\n")}`);
				if (!ok) throw new Error("The user did not approve the push.");
				const args = upstream ? ["push", id.remote, `HEAD:${git(root, ["config", `branch.${branch}.merge`]).trim()}`] : ["push", "--set-upstream", id.remote, branch];
				let out: string;
				try {
					out = git(root, args, {}, 180000);
				} catch (e: any) {
					const why = e.signal === "SIGTERM" ? "it took longer than 3 minutes" : `${e.stderr ?? e.message}`.trim();
					throw new Error(`git push failed: ${why}. git and ssh may not prompt here, so a key that needs a passphrase must be loaded in ssh-agent first.`);
				}
				return {
					content: [{ type: "text", text: `Pushed ${lines.length} commit(s) to ${target}.\n${out}`.trim() }],
					details: { remote: id.remote, branch, commits: lines.length },
				};
			},
		}),
	);
}
