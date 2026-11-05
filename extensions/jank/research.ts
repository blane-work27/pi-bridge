import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { extensionDir, stateDir } from "./paths.ts";

export interface ResearchRequest {
	id: string;
	question: string;
	brief: string;
	cwd: string;
	out: string;
	pi: string[];
	orchestratorModel: string;
	extensionDir: string;
	createdAt: string;
}

export interface ResearchStatus {
	state: "running" | "done" | "failed";
	out?: string;
	answer?: string;
	error?: string;
	startedAt?: string;
	finishedAt?: string;
	pid?: number;
}

export interface ResearchRun {
	id: string;
	dir: string;
	out: string;
	request: ResearchRequest;
	status: ResearchStatus;
	progress: string[];
}

function runsDir(): string {
	return join(stateDir(), "research", "runs");
}

function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "research";
}

function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function repoName(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return basename(dir);
		const up = join(dir, "..");
		if (up === dir) return basename(cwd) || "root";
		dir = up;
	}
}

export function launchResearch(opts: { question: string; brief: string; cwd: string; outDir?: string }): ResearchRun {
	const id = randomBytes(4).toString("hex");
	const dir = join(runsDir(), id);
	mkdirSync(dir, { recursive: true });
	const outDir = opts.outDir ?? join(stateDir(), "research", repoName(opts.cwd));
	mkdirSync(outDir, { recursive: true });
	const out = join(outDir, `${stamp(new Date())}-${slug(opts.question)}.md`);
	const request: ResearchRequest = {
		id,
		question: opts.question,
		brief: opts.brief,
		cwd: opts.cwd,
		out,
		pi: process.env.JANK_PI_BIN ? [process.env.JANK_PI_BIN] : [process.execPath, process.argv[1]],
		orchestratorModel: process.env.JANK_RESEARCH_MODEL || "claude-sub/claude-opus-5-5",
		extensionDir,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(join(dir, "request.json"), JSON.stringify(request, null, 2));
	writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "running", startedAt: request.createdAt } satisfies ResearchStatus));
	const log = openSync(join(dir, "runner.log"), "a");
	const child = spawn(process.execPath, [join(extensionDir, "research-run.ts"), dir], {
		cwd: opts.cwd,
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, JANK_ROLE: "research-runner" },
	});
	child.unref();
	return { id, dir, out, request, status: { state: "running", pid: child.pid }, progress: [] };
}

export function readRun(id: string): ResearchRun | undefined {
	const dir = join(runsDir(), id);
	if (!existsSync(join(dir, "request.json"))) return undefined;
	const request: ResearchRequest = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
	let status: ResearchStatus = { state: "running" };
	try {
		status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
	} catch {}
	if (status.state === "running" && status.pid) {
		try {
			process.kill(status.pid, 0);
		} catch {
			status = { ...status, state: "failed", error: "The research process exited without finishing. See runner.log." };
		}
	}
	let progress: string[] = [];
	try {
		progress = readFileSync(join(dir, "progress.log"), "utf8").split("\n").filter(Boolean);
	} catch {}
	return { id, dir, out: request.out, request, status, progress };
}

export function listRuns(limit: number): ResearchRun[] {
	if (!existsSync(runsDir())) return [];
	return readdirSync(runsDir())
		.map((name) => ({ name, t: statSync(join(runsDir(), name)).mtimeMs }))
		.sort((a, b) => b.t - a.t)
		.slice(0, limit)
		.map((e) => readRun(e.name))
		.filter((r): r is ResearchRun => !!r);
}
