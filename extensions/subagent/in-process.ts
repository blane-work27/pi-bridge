// In-process backend: one subagent is an AgentSession inside the orchestrator's pi.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { runAsSubagent } from "./child-marker.ts";
import { createFetchExtension } from "./fetch.ts";
import { FETCH_TOOL } from "./definitions.ts";
import { labelDialogs } from "./ui-proxy.ts";

/** Tools a subagent never inherits, by name or `prefix*` pattern. Also passed as `excludeTools`. */
export const NEVER_INHERITED = ["agent", "agent_send", "agent_stop", "agent_status", "jank_*"];

const isExcluded = (name: string) => NEVER_INHERITED.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

/** The orchestrator's active tools minus the ones a subagent must not have. */
export function inheritedTools(activeTools: string[]): string[] {
	return activeTools.filter((n) => !isExcluded(n));
}

export interface ChildRequest {
	cwd: string;
	label: string;
	prompt: string;
	appendSystemPrompt?: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	/** Start the MCP servers for this child (see `wantsMcp` in definitions.ts). */
	mcp?: boolean;
	/** The orchestrator's UI, or undefined when it has none (print mode). */
	ui: ExtensionUIContext | undefined;
	mode: "tui" | "rpc" | "json" | "print";
	projectTrusted: boolean;
	signal: AbortSignal | undefined;
	/** Every event of the child session, for progress tracking. */
	onEvent?: (event: any) => void;
	/** Directory for the subagent's session file (see transcripts.ts). */
	transcriptDir: string;
	/** The orchestrator's session file, recorded in the transcript header, when it has one. */
	parentSession?: string;
	/** Reopen this transcript and continue it, instead of starting a new one. */
	resumeFile?: string;
}

export interface ChildOutcome {
	text: string;
	turns: number;
	toolCalls: number;
	tokens: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	modelId: string;
	/** The subagent's session file. */
	transcript: string;
	thinkingLevel: ThinkingLevel;
}

export class SubagentError extends Error {}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new SubagentError("Subagent aborted before it started");
}

/** A live child session, set up but not yet prompted. `teardown()` must be called exactly once. */
export interface ChildHandle {
	/** Send the first (or a continuing) message and wait for the run to end. */
	prompt(text: string): Promise<ChildOutcome>;
	/** Queue a message for a running child: it is delivered after the current tool calls. */
	steer(text: string): Promise<void>;
	/** The child's session file, once it has one. */
	readonly sessionFile: string | undefined;
	teardown(): Promise<void>;
}

/** Create the child session, bind its extensions and start listening. Nothing is sent to the model yet. */
export async function startChild(req: Omit<ChildRequest, "prompt"> & { prompt?: string }): Promise<ChildHandle> {
	if (req.signal?.aborted) throw new SubagentError("Subagent aborted before it started");
	const agentDir = getAgentDir();
	// Without this the child would load an untrusted project's extensions: the default is trusted.
	const settingsManager = SettingsManager.create(req.cwd, agentDir, { projectTrusted: req.projectTrusted });
	const factories = [createCodemodeExtension(), ...(req.mcp ? [createMcpExtension()] : []), ...(req.tools.includes(FETCH_TOOL) ? [createFetchExtension()] : [])];
	const loader = new DefaultResourceLoader({
		cwd: req.cwd,
		agentDir,
		settingsManager,
		extensionFactories: factories,
		// Add to what pi discovers (<agentDir>/APPEND_SYSTEM.md, the pi-bridge addendum); an explicit source would replace it.
		...(req.appendSystemPrompt ? { appendSystemPromptOverride: (base: string[]) => [...base, req.appendSystemPrompt!] } : {}),
	});
	// The factories of the settings' extensions run during reload: this extension sees the mark and registers nothing.
	await runAsSubagent(() => loader.reload());
	assertNotAborted(req.signal);

	const { session } = await createAgentSession({
		cwd: req.cwd,
		agentDir,
		model: req.model,
		thinkingLevel: req.thinkingLevel,
		resourceLoader: loader,
		settingsManager,
		sessionManager: req.resumeFile
			? SessionManager.open(req.resumeFile, req.transcriptDir, req.cwd)
			: SessionManager.create(req.cwd, req.transcriptDir, req.parentSession ? { parentSession: req.parentSession } : undefined),
		tools: req.tools,
		excludeTools: NEVER_INHERITED,
	});

	const onAbort = () => void session.abort();
	req.signal?.addEventListener("abort", onAbort, { once: true });
	let toolCalls = 0;
	let tornDown = false;
	const teardownOnce = async () => {
		if (tornDown) return;
		tornDown = true;
		req.signal?.removeEventListener("abort", onAbort);
		await teardown(session);
	};
	try {
		await session.bindExtensions({ ...(req.ui ? { uiContext: labelDialogs(req.ui, req.label) } : {}), mode: req.mode });
		session.subscribe((ev: any) => {
			if (ev.type === "tool_execution_start") toolCalls++;
			req.onEvent?.(ev);
		});
		assertNotAborted(req.signal);
	} catch (e) {
		await teardownOnce();
		throw e;
	}
	return {
		async prompt(text) {
			// Stopped while the session was being set up: the task must never start.
			assertNotAborted(req.signal);
			await session.prompt(text, { expandPromptTemplates: false });
			// A steer accepted after the loop's last check is still queued: run it as a continuation.
			while (!req.signal?.aborted && session.pendingMessageCount > 0) {
				const { steering, followUp } = session.clearQueue();
				await session.prompt([...steering, ...followUp].join("\n\n"), { expandPromptTemplates: false });
			}
			assertNotAborted(req.signal);
			return outcome(session, toolCalls);
		},
		async steer(text) {
			await session.steer(text);
		},
		get sessionFile() {
			return session.sessionFile;
		},
		teardown: teardownOnce,
	};
}

export async function runInProcess(req: ChildRequest): Promise<ChildOutcome> {
	const child = await startChild(req);
	try {
		return await child.prompt(req.prompt);
	} finally {
		await child.teardown();
	}
}

function outcome(session: AgentSession, toolCalls: number): ChildOutcome {
	const last: any = [...session.messages].reverse().find((m: any) => m.role === "assistant");
	if (last?.stopReason === "error" || last?.stopReason === "aborted") {
		throw new SubagentError(last.errorMessage || `Subagent stopped: ${last.stopReason}`);
	}
	const stats = session.getSessionStats();
	return {
		text: session.getLastAssistantText() ?? "",
		turns: stats.assistantMessages,
		toolCalls,
		tokens: stats.tokens.total,
		usage: { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, total: stats.tokens.total },
		modelId: session.model?.id ?? "",
		transcript: session.sessionFile ?? "",
		thinkingLevel: session.thinkingLevel,
	};
}

/** Reopen a saved transcript and continue it with a new message. Used by tests; `agent_send` goes through the backends. */
export function resumeSubagent(file: string, message: string, req: Omit<ChildRequest, "prompt" | "resumeFile">): Promise<ChildOutcome> {
	return runInProcess({ ...req, prompt: message, resumeFile: file });
}

/**
 * Always runs, on finish, error and abort. `dispose()` alone never emits session_shutdown, so
 * the MCP extension would leave its servers running; this is the order pi's own runtime uses.
 */
async function teardown(session: AgentSession): Promise<void> {
	try {
		await session.abort();
	} finally {
		try {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session.dispose();
		}
	}
}
