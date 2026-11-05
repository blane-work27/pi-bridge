import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MODEL, resolveModel, resolveTools, runWorker, workers } from "./runner.ts";
import { launchResearch, listRuns, readRun, type ResearchRun } from "./research.ts";
import { applyToTree, collectPatch, createWorktree, finishIntegration, mergePatches, removeWorktree, repoRoot, snapshot } from "./worktree.ts";

const anyObject = Type.Object({}, { additionalProperties: true });

function id(): string {
	return randomBytes(4).toString("hex");
}

function text(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function result(data: Record<string, unknown>, isError = false) {
	const body = text(data);
	return {
		content: [{ type: "text" as const, text: body.length > 30000 ? `${body.slice(0, 30000)}\n[truncated]` : body }],
		structuredContent: data as any,
		details: undefined,
		...(isError ? { isError: true } : {}),
	};
}

function absCwd(cwd: string | undefined, fallback: string): string {
	if (!cwd) return fallback;
	return isAbsolute(cwd) ? cwd : resolve(fallback, cwd);
}

const workerTool = defineTool({
	name: "jank_worker",
	label: "jank worker",
	description: `Run one worker agent on a gateway (icr-*) model through Bifrost and return its answer. Workers run in a separate pi process with no memory of this conversation, so the prompt must contain everything the worker needs. Call many of these in parallel from a codemode script; at most ${process.env.JANK_CONCURRENCY || 4} run at once and the rest queue. Read the jank skill before you write a jank script.`,
	parameters: Type.Object({
		prompt: Type.String({ description: "The complete task for the worker." }),
		label: Type.Optional(Type.String({ description: "Short name for progress output and worktree names." })),
		model: Type.Optional(Type.String({ description: `Gateway model id. Default ${DEFAULT_MODEL}.` })),
		schema: Type.Optional(anyObject),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Worker tools from: read, grep, find, ls, edit, write, bash, jank_fetch. Default read, grep, find, ls; with isolation worktree also edit and write." })),
		isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
		base: Type.Optional(Type.String({ description: "Base commit from jank_snapshot. Default: a new snapshot of the working tree." })),
		link: Type.Optional(Type.Array(Type.String(), { description: "Ignored directories to symlink into the worktree, for example node_modules." })),
		cwd: Type.Optional(Type.String({ description: "Working directory. Default: the session directory." })),
		timeout_s: Type.Optional(Type.Number({ description: "Timeout per attempt in seconds. Default 600." })),
	}),
	outputSchema: anyObject,
	exposure: "codemode",
	executionMode: "parallel",
	async execute(_id, params, signal, onUpdate, ctx) {
		const label = params.label || "worker";
		const isolated = params.isolation === "worktree";
		const model = resolveModel(params.model);
		const tools = resolveTools(params.tools, isolated);
		const cwd = absCwd(params.cwd, ctx.cwd);
		return workers.run(async () => {
			let wt: ReturnType<typeof createWorktree> | undefined;
			try {
				let workCwd = cwd;
				if (isolated) {
					const root = repoRoot(cwd);
					wt = createWorktree(root, params.base || snapshot(root), label, params.link ?? []);
					const rel = cwd.slice(root.length).replace(/^\//, "");
					workCwd = rel ? resolve(wt.dir, rel) : wt.dir;
				}
				onUpdate?.({ content: [{ type: "text", text: `${label}: running on ${model}` }], details: undefined });
				const run = await runWorker({
					prompt: params.prompt,
					model,
					tools,
					cwd: workCwd,
					schema: params.schema,
					timeoutMs: Math.max(30, params.timeout_s ?? 600) * 1000,
					signal,
					onEvent: (m) => onUpdate?.({ content: [{ type: "text", text: `${label}: ${m}` }], details: undefined }),
				});
				const out: Record<string, unknown> = {
					ok: run.ok,
					label,
					model,
					text: run.text,
					attempts: run.attempts,
					duration_ms: run.durationMs,
					tool_calls: run.toolCalls,
					usage: run.usage,
				};
				if (run.data !== undefined) out.data = run.data;
				if (run.error) out.error = run.error;
				if (wt) {
					const p = collectPatch(wt, `${label.replace(/[^a-z0-9._-]+/gi, "-")}-${id()}`);
					out.base = wt.base;
					out.patch = p.patch;
					out.diffstat = p.stat;
					out.files = p.files;
				}
				return result(out, !run.ok);
			} finally {
				if (wt) removeWorktree(wt);
			}
		});
	},
});

const snapshotTool = defineTool({
	name: "jank_snapshot",
	label: "jank snapshot",
	description: "Snapshot the working tree (tracked, modified and untracked files) as a base commit for isolated workers. No branch, index, or stash changes. Pass the result as base to every jank_worker in one fan-out, so their patches share a base.",
	parameters: Type.Object({ cwd: Type.Optional(Type.String()) }),
	outputSchema: anyObject,
	exposure: "codemode",
	async execute(_id, params, _signal, _onUpdate, ctx) {
		const root = repoRoot(absCwd(params.cwd, ctx.cwd));
		return result({ root, base: snapshot(root) });
	},
});

const mergeTool = defineTool({
	name: "jank_merge",
	label: "jank merge",
	description: "Combine worker patches in a separate integration worktree, never in the user's tree. Applies each patch with git apply --3way in order. With no conflicts it returns one combined patch. With conflicts it returns the integration directory; give it to a jank_worker (isolation none, cwd = that directory, tools read, grep, find, ls, edit) to resolve the conflict markers, then call jank_merge with integration set to finish.",
	parameters: Type.Object({
		patches: Type.Optional(Type.Array(Type.String(), { description: "Patch paths from jank_worker results, in the order to apply." })),
		integration: Type.Optional(Type.String({ description: "An integration directory from an earlier jank_merge call with conflicts, after the conflicts are resolved." })),
		link: Type.Optional(Type.Array(Type.String())),
	}),
	outputSchema: anyObject,
	exposure: "codemode",
	async execute(_id, params) {
		if (params.integration) return result(finishIntegration(params.integration, id()) as any);
		const patches = params.patches ?? [];
		if (!patches.length) throw new Error("Give patches or integration.");
		const metas = patches.map((p) => {
			if (!existsSync(`${p}.json`)) throw new Error(`${p} is not a jank patch.`);
			return JSON.parse(readFileSync(`${p}.json`, "utf8"));
		});
		const root = metas[0].root;
		if (metas.some((m) => m.root !== root)) throw new Error("All patches must come from one repository.");
		return result(mergePatches(root, metas[0].base, patches, id(), params.link ?? []) as any);
	},
});

const applyTool = defineTool({
	name: "jank_apply",
	label: "jank apply",
	description: "Apply one patch to the user's working tree as unstaged changes. It runs git apply --check first and changes nothing if the patch does not apply. It never stages or commits.",
	parameters: Type.Object({ patch: Type.String(), cwd: Type.Optional(Type.String()) }),
	outputSchema: anyObject,
	exposure: "codemode",
	async execute(_id, params, _signal, _onUpdate, ctx) {
		const r = applyToTree(absCwd(params.cwd, ctx.cwd), params.patch);
		return result(r, !r.applied);
	},
});

function summary(run: ResearchRun): string {
	const head = `jank research ${run.id} is ${run.status.state}.`;
	if (run.status.state === "done") return `${head}\nFile: ${run.status.out}\nQuestion: ${run.request.question}\n\n${run.status.answer ?? ""}`;
	if (run.status.state === "failed") return `${head}\nError: ${run.status.error}\nLog: ${run.dir}/progress.log`;
	return `${head}\nQuestion: ${run.request.question}\nProgress:\n${run.progress.slice(-8).join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	const role = process.env.JANK_ROLE;
	if (role === "worker") return;
	pi.registerTool(workerTool);
	pi.registerTool(snapshotTool);
	pi.registerTool(mergeTool);
	pi.registerTool(applyTool);
	if (role === "research") return;

	const watched = new Set<string>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let uiNotify: ((msg: string) => void) | undefined;

	const poll = () => {
		for (const runId of [...watched]) {
			const run = readRun(runId);
			if (!run || run.status.state === "running") continue;
			watched.delete(runId);
			uiNotify?.(`jank research ${runId} ${run.status.state}`);
			pi.sendMessage(
				{ customType: "jank-research", content: summary(run), display: true, details: { id: runId, state: run.status.state, out: run.status.out } },
				{ deliverAs: "nextTurn" },
			);
		}
		if (!watched.size && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	pi.registerTool(
		defineTool({
			name: "jank_research",
			label: "jank research",
			description:
				"Start a background research run on one narrow question and return at once. A separate orchestrator reads primary sources with gateway-model workers, verifies each claim, and writes one cited Markdown file. You get a message with the answer when it finishes, so keep working. Read the jank-research skill for how to write the brief.",
			promptSnippet: "Start background research on a factual question",
			parameters: Type.Object({
				question: Type.String({ description: "The narrow, answerable question." }),
				brief: Type.String({ description: "Why it matters, which decision it unblocks, settled facts with sources, constraints, and repo paths the researcher may read." }),
				out_dir: Type.Optional(Type.String({ description: "Directory for the result file. Default ~/.local/state/jank/research/<repo>/." })),
				cwd: Type.Optional(Type.String()),
			}),
			outputSchema: anyObject,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const run = launchResearch({
					question: params.question,
					brief: params.brief,
					cwd: absCwd(params.cwd, ctx.cwd),
					outDir: params.out_dir ? absCwd(params.out_dir, ctx.cwd) : undefined,
				});
				watched.add(run.id);
				if (ctx.hasUI) uiNotify = (m) => ctx.ui.notify(m, "info");
				if (!timer) timer = setInterval(poll, 5000);
				return result({
					id: run.id,
					state: "running",
					out: run.out,
					note: "The run is in the background. Continue with work that does not depend on the answer. A message with the result arrives when it finishes. Use jank_research_status to check on it.",
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "jank_research_status",
			label: "jank research status",
			description: "Show the state and recent progress of jank research runs. Without id, list recent runs.",
			parameters: Type.Object({ id: Type.Optional(Type.String()) }),
			outputSchema: anyObject,
			async execute(_id, params) {
				if (!params.id) return result({ runs: listRuns(10).map((r) => ({ id: r.id, state: r.status.state, question: r.request.question, out: r.status.out ?? r.out })) });
				const run = readRun(params.id);
				if (!run) throw new Error(`No jank research run ${params.id}.`);
				return result({ id: run.id, state: run.status.state, summary: summary(run) });
			},
		}),
	);
}
