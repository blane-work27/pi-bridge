import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { stateDir } from "./paths.ts";

const STALE_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, args: string[], env?: Record<string, string>): string {
	return execFileSync("git", args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function tryGit(cwd: string, args: string[]): { ok: boolean; out: string } {
	try {
		return { ok: true, out: git(cwd, args) };
	} catch (e: any) {
		return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message) };
	}
}

export function repoRoot(cwd: string): string {
	const r = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!r.ok) throw new Error(`${cwd} is not inside a git repository. isolation "worktree" needs one.`);
	return r.out.trim();
}

function repoKey(root: string): string {
	return `${basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

function worktreeDir(root: string): string {
	return join(stateDir(), "wt", repoKey(root));
}

export function patchDir(root: string): string {
	return join(stateDir(), "patches", repoKey(root));
}

function safeLabel(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "worker";
}

const pruned = new Set<string>();

export function pruneStale(root: string): void {
	if (pruned.has(root)) return;
	pruned.add(root);
	const dir = worktreeDir(root);
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			try {
				if (Date.now() - statSync(p).mtimeMs > STALE_MS) {
					tryGit(root, ["worktree", "remove", "--force", p]);
					rmSync(p, { recursive: true, force: true });
				}
			} catch {}
		}
	}
	tryGit(root, ["worktree", "prune"]);
}

export function snapshot(root: string): string {
	const tmp = mkdtempSync(join(tmpdir(), "jank-index-"));
	const index = join(tmp, "index");
	try {
		const env = { GIT_INDEX_FILE: index };
		const head = tryGit(root, ["rev-parse", "--verify", "HEAD"]);
		if (head.ok) git(root, ["read-tree", "HEAD"], env);
		git(root, ["add", "-A"], env);
		const tree = git(root, ["write-tree"], env).trim();
		const args = ["commit-tree", tree, "-m", "jank base"];
		if (head.ok) args.splice(2, 0, "-p", head.out.trim());
		return git(root, args, {
			GIT_AUTHOR_NAME: "jank",
			GIT_AUTHOR_EMAIL: "jank@localhost",
			GIT_COMMITTER_NAME: "jank",
			GIT_COMMITTER_EMAIL: "jank@localhost",
			GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		}).trim();
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

export interface Worktree {
	root: string;
	base: string;
	dir: string;
	label: string;
	links: string[];
}

export function createWorktree(root: string, base: string, label: string, links: string[]): Worktree {
	pruneStale(root);
	const parent = worktreeDir(root);
	mkdirSync(parent, { recursive: true });
	const dir = join(parent, `${safeLabel(label)}-${randomBytes(4).toString("hex")}`);
	git(root, ["worktree", "add", "--detach", dir, base]);
	const linked: string[] = [];
	for (const link of links) {
		if (isAbsolute(link) || link.split(/[\\/]/).includes("..")) throw new Error(`link "${link}" must be a path inside the repository.`);
		const src = resolve(root, link);
		const dst = resolve(dir, link);
		if (!existsSync(src)) continue;
		if (existsSync(dst)) continue;
		mkdirSync(resolve(dst, ".."), { recursive: true });
		symlinkSync(src, dst);
		linked.push(relative(dir, dst));
	}
	return { root, base, dir, label, links: linked };
}

export interface PatchResult {
	patch: string | null;
	stat: string;
	files: string[];
}

function excludes(links: string[]): string[] {
	return links.map((l) => `:(exclude)${l}`);
}

export function collectPatch(wt: Worktree, id: string): PatchResult {
	for (const link of wt.links) {
		try {
			unlinkSync(join(wt.dir, link));
		} catch {}
	}
	git(wt.dir, ["add", "-A", "--", ".", ...excludes(wt.links)]);
	const diff = git(wt.dir, ["diff", "--cached", "--binary", wt.base]);
	if (!diff.trim()) return { patch: null, stat: "", files: [] };
	const stat = git(wt.dir, ["diff", "--cached", "--stat", wt.base]).trim();
	const files = git(wt.dir, ["diff", "--cached", "--name-only", wt.base]).split("\n").filter(Boolean);
	const dir = patchDir(wt.root);
	mkdirSync(dir, { recursive: true });
	const patch = join(dir, `${id}.patch`);
	writeFileSync(patch, diff);
	writeFileSync(`${patch}.json`, JSON.stringify({ root: wt.root, base: wt.base, label: wt.label, files }, null, 2));
	return { patch, stat, files };
}

export function removeWorktree(wt: Worktree): void {
	tryGit(wt.root, ["worktree", "remove", "--force", wt.dir]);
	rmSync(wt.dir, { recursive: true, force: true });
	tryGit(wt.root, ["worktree", "prune"]);
}

export interface MergeResult {
	applied: string[];
	conflicts: { patch: string; detail: string }[];
	combined: string | null;
	stat: string;
	integration: string | null;
	base: string;
}

export function mergePatches(root: string, base: string, patches: string[], id: string, links: string[]): MergeResult {
	const wt = createWorktree(root, base, `merge-${id}`, links);
	const applied: string[] = [];
	const conflicts: { patch: string; detail: string }[] = [];
	for (const p of patches) {
		const r = tryGit(wt.dir, ["apply", "--3way", "--whitespace=nowarn", p]);
		if (r.ok) applied.push(p);
		else conflicts.push({ patch: p, detail: r.out.slice(0, 2000) });
	}
	if (conflicts.length) {
		writeFileSync(join(wt.dir, ".git-jank-merge.json"), JSON.stringify({ root, base, links: wt.links }));
		return { applied, conflicts, combined: null, stat: "", integration: wt.dir, base };
	}
	const out = collectPatch(wt, `merge-${id}`);
	removeWorktree(wt);
	return { applied, conflicts, combined: out.patch, stat: out.stat, integration: null, base };
}

export function finishIntegration(dir: string, id: string): MergeResult {
	const metaPath = join(dir, ".git-jank-merge.json");
	if (!existsSync(metaPath)) throw new Error(`${dir} is not a jank merge worktree.`);
	const meta = JSON.parse(readFileSync(metaPath, "utf8"));
	unlinkSync(metaPath);
	const markers = tryGit(dir, ["grep", "-n", "-I", "--untracked", "-E", "^(<<<<<<<|>>>>>>>)( |$)"]);
	if (markers.ok && markers.out.trim()) {
		writeFileSync(metaPath, JSON.stringify(meta));
		throw new Error(`Conflict markers remain:\n${markers.out.slice(0, 2000)}`);
	}
	const wt: Worktree = { root: meta.root, base: meta.base, dir, label: `merge-${id}`, links: meta.links };
	const out = collectPatch(wt, `merge-${id}`);
	removeWorktree(wt);
	return { applied: [], conflicts: [], combined: out.patch, stat: out.stat, integration: null, base: meta.base };
}

export function applyToTree(cwd: string, patch: string): { applied: boolean; detail: string } {
	const root = repoRoot(cwd);
	const check = tryGit(root, ["apply", "--check", "--whitespace=nowarn", patch]);
	if (!check.ok) return { applied: false, detail: check.out };
	const r = tryGit(root, ["apply", "--whitespace=nowarn", patch]);
	return { applied: r.ok, detail: r.out };
}
