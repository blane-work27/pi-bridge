// pi-bridge subagents: one `agent` tool, shaped like Claude Code's Agent tool.
// Usage and design: extensions/subagent/README.md
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentRegistry, newAgentId } from "./backend.ts";
import { sharedSubagents, type SharedSubagents } from "./shared.ts";
import { insideSubagent } from "./child-marker.ts";
import { buildControlTools, finishNotice } from "./control-tools.ts";
import { fetchTool } from "./fetch.ts";
import { HerdrBackend, herdrTerminalId, insideHerdrChild } from "./herdr-backend.ts";
import { HcTerminals, type HerdrTerminals } from "./herdr-terminals.ts";
import { InProcessBackend } from "./in-process-backend.ts";
import { withSlot } from "./concurrency.ts";
import { listAgents, resolveAgent, type AgentDefinition, type AgentFolders } from "./definitions.ts";
import { resolveModel, THINKING_LEVELS } from "./models.ts";
import { inheritedTools, runInProcess } from "./in-process.ts";
import { ProgressTracker } from "./progress.ts";
import { renderAgentCall, renderAgentResult } from "./render.ts";
import { transcriptDir } from "./transcripts.ts";
import { createWorktree, finishWorktree, worktreeNote } from "./worktrees.ts";

function describeTool(defs: AgentDefinition[]): string {
	const agents = defs
		.map((a) => `- ${a.name}: ${a.description}`)
		.join("\n");
	return [
		"Launch a subagent to do a task in a fresh context and return its final message.",
		"",
		"Available agents:",
		agents,
		"",
		"How to use it:",
		"- The subagent sees none of this conversation. Make the prompt self-contained: the goal, the relevant paths and facts, and what to report back.",
		"- Only the subagent's final message comes back to you, as this tool's result. Ask for exactly what you need in it.",
		"- To run subagents in parallel, make several agent calls in one message.",
		"- The subagent cannot start subagents of its own.",
		"- model and thinking override the agent's model and thinking level for one call; by default a subagent uses its definition's, else yours.",
		"- isolation: \"worktree\" gives the subagent its own git worktree and branch (agent/<type>-<id>), cut from your current HEAD (uncommitted changes are not carried over), so parallel editing subagents touch neither your tree nor each other's. If it changed nothing the worktree is removed; otherwise the result gives its path and branch.",
		"- With run_in_background: true the call returns at once with the subagent's id. You get a notice with its final message when it finishes; meanwhile use agent_send (steer a running one, or continue a finished one), agent_stop and agent_status.",
	].join("\n");
}

export interface SubagentExtensionOptions {
	/** Where `HC_TERMINAL_ID` and the no-nesting marker are read from, on every call. Default `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** The `hc` binary, when it is not `hc` on the PATH (tests give a fake). */
	hcBin?: string;
	/** Replaces the whole Herdr terminal interface. */
	terminals?: HerdrTerminals;
	/** The launcher a Herdr child runs. Default `pi-bridge`. */
	piBin?: string;
}

/** `folders` points the loader at other agent folders (tests use temp dirs). */
export function createSubagentExtension(folders?: AgentFolders, options: SubagentExtensionOptions = {}) {
	const env = () => options.env ?? process.env;
	return function (pi: ExtensionAPI) {
		// A subagent's own copy of this extension registers nothing, so subagents cannot nest:
		// an in-process child is marked through its session setup, a Herdr child by its environment.
		if (insideSubagent()) return;
		if (insideHerdrChild(env())) {
			// A Herdr child is a separate pi, so nothing else loads the fetch tool for it: register just that
			// one, and the child's `--tools` decides whether it is active.
			pi.registerTool(fetchTool);
			return;
		}

		// One registry per process, whichever copy of the extension or session made it: background subagents
		// outlive /new, /resume, /fork and reload, and only a quit stops them (below).
		// Inside a Herdr terminal (HC_TERMINAL_ID, never HC_SCOPE) background subagents get their own terminals.
		const inProcess = new InProcessBackend();
		const herdr = new HerdrBackend({ terminals: options.terminals ?? new HcTerminals({ bin: options.hcBin }), parent: () => herdrTerminalId(env()), piBin: options.piBin });
		const choose = () => (herdrTerminalId(env()) ? herdr : inProcess);
		const envOption = { get env() { return env(); } };
		const shared = sharedSubagents(pi, () => new AgentRegistry(choose, envOption));
		shared.registry.rebind(choose, envOption);
		const registry = shared.registry;
		for (const tool of buildControlTools(registry)) pi.registerTool(tool);
		// Only a quit ends background subagents; a new, resumed, forked or reloaded session keeps them.
		pi.on("session_shutdown", async (e) => {
			if (e.reason === "quit") await registry.stopAll();
		});

		const register = (cwd: string, trusted: boolean) => pi.registerTool(buildTool(pi, shared, folders, registry, listAgents({ cwd, trusted, folders }), env));
		// The description lists the agents, so it is rebuilt once the cwd and trust are known.
		register(process.cwd(), false);
		pi.on("session_start", (_e, ctx) => register(ctx.cwd, ctx.isProjectTrusted()));
	};
}

export default createSubagentExtension();

function buildTool(pi: ExtensionAPI, shared: SharedSubagents, folders: AgentFolders | undefined, registry: AgentRegistry, defs: AgentDefinition[], env: () => NodeJS.ProcessEnv) {
	return (
		defineTool({
			name: "agent",
			label: "agent",
			description: describeTool(defs),
			parameters: Type.Object({
				description: Type.String({ description: "A short (3-5 word) description of the task. Shown in the UI and on the subagent's approval dialogs." }),
				prompt: Type.String({ description: "The task for the subagent. It must be self-contained." }),
				subagent_type: Type.String({ description: "The agent type to use, from the list in this tool's description." }),
				model: Type.Optional(Type.String({ description: "Optional model override for this call." })),
				thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((l) => Type.Literal(l)), { description: "Optional thinking level for this call. Default: the agent definition's `thinking:`, else yours. The model's nearest supported level is used." })),
				isolation: Type.Optional(Type.Literal("worktree", { description: "Run the subagent in its own git worktree on a new branch, cut from your HEAD. The working directory must be in a git repository." })),
				run_in_background: Type.Optional(Type.Boolean({ description: "Return at once with the subagent's id instead of waiting. You get a notice with its final message when it finishes." })),
			}),
			// Without this explicit mode a sequential tool such as git_commit in the same message serialises the batch.
			executionMode: "parallel",
			async execute(_id, params, signal, onUpdate, ctx) {
				// Re-read on every call: an edit to a definition applies without a restart.
				const trusted = ctx.isProjectTrusted();
				const available = listAgents({ cwd: ctx.cwd, trusted, folders });
				const def = available.find((a) => a.name === params.subagent_type);
				if (!def) {
					const known = available.map((a) => a.name).join(", ");
					throw new Error(`Unknown subagent_type "${params.subagent_type}". Available: ${known}`);
				}
				const agent = resolveAgent(def, inheritedTools(pi.getActiveTools()));
				if (!ctx.model) throw new Error("The orchestrator has no model to inherit");
				// Resolve before any session exists: an unknown model or level fails here and starts no child.
				const resolved = resolveModel({
					requested: params.model,
					definitionModel: agent.model,
					requestedThinking: params.thinking,
					definitionThinking: agent.thinking,
					orchestrator: { model: ctx.model, thinkingLevel: pi.getThinkingLevel() },
					registry: ctx.modelRegistry,
				});
				if (!resolved.ok) throw new Error(resolved.error);
				if (params.run_in_background) {
					const label = `${agent.name}: ${params.description}`;
					const started = await registry.launch(
						{
							agentType: agent.name,
							description: params.description,
							cwd: ctx.cwd,
							isolation: params.isolation,
							prompt: params.prompt,
							appendSystemPrompt: agent.systemPrompt || undefined,
							model: resolved.model,
							thinkingLevel: resolved.thinkingLevel,
							tools: agent.toolList,
							mcp: agent.mcp,
							ui: ctx.hasUI ? ctx.ui : undefined,
							mode: ctx.mode,
							projectTrusted: trusted,
							transcriptDir: transcriptDir(ctx.sessionManager.getSessionFile()),
							parentSession: ctx.sessionManager.getSessionFile(),
						},
						(id, result) => {
							try {
								// Whichever session is current now, not the one that started the subagent.
								shared.pi.sendMessage(finishNotice(id, label, result), { triggerTurn: true });
							} catch {
								// The orchestrator is already gone: nobody to tell.
							}
						},
					);
					const where = started.address ? ` at ${started.address}` : "";
					const wtNote = started.worktree ? ` Its worktree: ${started.worktree.path} on branch ${started.worktree.branch}.` : "";
					return {
						content: [{ type: "text", text: `Started background subagent ${started.id} (backend: ${started.backend}${where}).${wtNote} You will get a notice with its final message when it finishes. Use agent_send, agent_stop and agent_status with this id.` }],
						details: { background: true, ...started },
					};
				}
				const worktree = params.isolation === "worktree" ? createWorktree({ cwd: ctx.cwd, id: newAgentId(agent.name, () => false), env: env() }) : undefined;
				// Judged when the run ends, however it ends: removed when clean, kept (and reported) otherwise.
				const settleWorktree = () => {
					const done = worktree && finishWorktree(worktree);
					return done && !done.removed ? done.info : undefined;
				};
				const progress = new ProgressTracker(agent.name, params.description);
				const push = () => {
					const details = progress.snapshot();
					const text = details.status === "queued" ? `${agent.name}: ${params.description}: queued` : `${agent.name}: ${params.description} (${details.toolCalls} tool calls, ${details.tokens} tokens)`;
					onUpdate?.({ content: [{ type: "text", text }], details });
				};
				const onQueued = () => {
					progress.setStatus("queued");
					push();
				};
				const outcome = await withSlot(signal, onQueued, () => {
				progress.setStatus("running");
				return runInProcess({
					cwd: worktree?.cwd ?? ctx.cwd,
					label: `${agent.name}: ${params.description}`,
					prompt: params.prompt,
					appendSystemPrompt: agent.systemPrompt || undefined,
					model: resolved.model,
					thinkingLevel: resolved.thinkingLevel,
					tools: agent.toolList,
					mcp: agent.mcp,
					ui: ctx.hasUI ? ctx.ui : undefined,
					mode: ctx.mode,
					projectTrusted: trusted,
					signal,
					transcriptDir: transcriptDir(ctx.sessionManager.getSessionFile()),
					parentSession: ctx.sessionManager.getSessionFile(),
					onEvent: (ev) => {
						if (progress.onEvent(ev)) push();
					},
				});
				}).catch((err) => {
					const info = settleWorktree();
					if (info && err instanceof Error) err.message += worktreeNote(info);
					throw err;
				});
				const info = settleWorktree();
				return {
					content: [{ type: "text", text: (outcome.text || "(the subagent returned no text)") + worktreeNote(info) }],
					details: { ...progress.finish({ model: outcome.modelId, turns: outcome.turns, usage: outcome.usage }), thinkingLevel: outcome.thinkingLevel, transcript: outcome.transcript, ...(info ? { worktree: info } : {}) },
				};
			},
			renderCall: (args, theme) => renderAgentCall(args, theme),
			renderResult: (result, opts, theme) => renderAgentResult(result, opts, theme),
		})
	);
}
