// Test harness for the subagent extension.
//
// A `World` is a real pi SDK session (the orchestrator) with the extension listed in a temp
// agentDir's settings.json. Parent and children both run on pi's
// faux model provider: the agentDir's models.json gives provider `bifrost` a faux api, so the
// child sessions the extension creates reach the same scripted provider with no test seam in the
// production code. The UI is a recording UI, and a tiny stdio MCP server counts leaked processes.
//
//   const w = await createWorld({ mcp: true });
//   const run = await w.run([{ description: "look", prompt: "OK hello" }]);
//   run.results[0].text  // the subagent's final message
//   await w.close();
//
// Scripted behaviour (the faux "model" for parent and children is one router, see `route`):
//   the parent calls `agent` once per entry of `run(calls)`, in one message, then says "parent done".
//   a child acts on its prompt:
//     OK <text>        final message "done: <text>"
//     TOOLS            final message: JSON list of the tool names the child was given
//     PROMPT           final message: the child's system prompt
//     ASK <tag>        calls probe_ask (a dialog), final message is the tool's answer
//     FAIL <message>   the provider errors with <message>
//     BASH <command>   runs the command with bash, then "done: bash"
//     SLOWFAIL <msg>   bash sleep 1, then the provider errors with <msg> (an error after MCP has started)
//     GATE <path>      bash: touch <path>.started, then wait until <path>.go exists (a child the test releases by hand)
//     PING             calls the fixture's MCP tool through codemode; final message is what the script returned
//     FETCH <json>     calls the fetch tool with the JSON arguments; final message is the tool's output or error
//     HOLD <file>      bash: sleep 300 in the background, its pid to <file>.pid, touch <file>, wait (a child that is
//                      mid-turn until aborted; check that exact sleep with holdPid and isRunning)
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "../../extensions/subagent");
const probePath = join(here, "fixtures/probe.ts");
const askToolsPath = join(here, "fixtures/ask-tools-extension.ts");
const mcpServerPath = join(here, "fixtures/mcp-server.mjs");
const MODEL_ID = "claude-sub/claude-sonnet-5-5";
/** Every model the faux bifrost provider lists, as pi-bridge's models.json does for the ones the tests use. */
export const MODEL_IDS = [MODEL_ID, "claude-sub/claude-opus-5-5", "claude-sub/claude-haiku-5-5", "icr-qwen/qwen3.8"];

export interface Dialog {
	kind: "confirm" | "select" | "input";
	title: string;
	message: string;
	/** Settle the dialog by hand when the world has no `answer` policy for it. */
	resolve(value: unknown): void;
}

/** A recording UI context: a plain object (pi spreads it), every dialog is logged. */
export function recordingUI(world: { dialogs: Dialog[]; answer?: (d: Dialog) => unknown }) {
	const ask = (kind: Dialog["kind"], title: string, message = "") =>
		new Promise<unknown>((resolve) => {
			const d: Dialog = { kind, title, message, resolve };
			world.dialogs.push(d);
			const auto = world.answer?.(d);
			if (auto !== undefined) resolve(auto);
		});
	const noop = () => {};
	return {
		confirm: (title: string, message: string) => ask("confirm", title, message),
		select: (title: string, _options: string[]) => ask("select", title),
		input: (title: string) => ask("input", title),
		notify: noop,
		onTerminalInput: () => noop,
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		custom: async () => undefined,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		theme: undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "recording UI" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	} as any;
}

export interface AgentCall {
	description: string;
	prompt: string;
	subagent_type?: string;
	model?: string;
	run_in_background?: boolean;
	isolation?: "worktree";
}

export interface CallResult {
	isError: boolean;
	text: string;
	details: any;
}

export interface WorldOptions {
	/** Write an mcp.json with the stdio fixture server. Children then start it. */
	mcp?: boolean;
	/** Load fixtures/ask-tools-extension.ts: a call to one of these tools raises a confirm dialog, and declining blocks it. */
	askTools?: string[];
	/** A project directory, created with `.pi/extensions/` holding the untrusted-project fixture. */
	untrustedProject?: boolean;
	/** Markdown files (file name to content) for the user's agents folder, a temp dir the extension reads instead of ~/.claude/agents. */
	userAgents?: Record<string, string>;
	/** Markdown files for the project's `.claude/agents/`. */
	projectAgents?: Record<string, string>;
	/** Treat the project as trusted (default: untrusted). */
	trustedProject?: boolean;
	/** Give the orchestrator a session file under `<root>/sessions` (default: in-memory, no file). */
	persist?: boolean;
	/** Run as inside Herdr: `HC_TERMINAL_ID` is set and `hc` is a fake (see `w.herdr`). Default: outside Herdr, `HC_*` cleared. */
	herdr?: boolean;
	/** Make the project directory a git repository with one commit (`README`), for `isolation: "worktree"`. */
	git?: boolean;
	/** Write `<agentDir>/APPEND_SYSTEM.md` (the pi-bridge addendum pi appends to every system prompt) with this text. */
	appendSystem?: string;
	/** Answer dialogs automatically. Return undefined to leave one for the test to settle. */
	answer?: (d: Dialog) => unknown;
}

export interface Run {
	/** Settles when the parent's turn is over. */
	done: Promise<void>;
	/** One entry per tool call, in call order. */
	results(): CallResult[];
	/** The `details` of every progress update of call `i` (the tool's onUpdate), in order. */
	updates(i: number): any[];
}

let worldCount = 0;

// Each world's temp dir is removed when the test file's process exits, not in close(): some tests check a
// world's files (kept worktrees) after closing it.
const roots: string[] = [];
process.on("exit", () => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

export async function createWorld(opts: WorldOptions = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-test-")));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const pidFile = join(root, "mcp-pids");
	writeFileSync(pidFile, "");
	const untrustedMarker = join(root, "untrusted-loaded");
	if (opts.untrustedProject) {
		mkdirSync(join(cwd, ".pi/extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi/extensions/evil.ts"), readFileSync(join(here, "fixtures/untrusted-project-extension.ts")));
	}

	// Never the real Herdr: the tests may run in a Herdr terminal. `hc` is a fake script when a test asks for Herdr.
	delete process.env.HC_TERMINAL_ID;
	delete process.env.HC_SCOPE;
	delete process.env.PI_SUBAGENT;
	const hcDir = join(root, "fake-hc");
	const fakeHcBin = join(root, "fake-hc.sh");
	mkdirSync(hcDir, { recursive: true });
	writeFileSync(join(hcDir, "calls.jsonl"), "");
	writeFileSync(fakeHcBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, "fixtures/fake-hc.mjs"))} "$@"\n`);
	chmodSync(fakeHcBin, 0o755);
	process.env.FAKE_HC_DIR = hcDir;
	if (opts.herdr) process.env.HC_TERMINAL_ID = "t1";

	const userAgentsDir = join(root, "user-agents");
	mkdirSync(userAgentsDir, { recursive: true });
	for (const [file, content] of Object.entries(opts.userAgents ?? {})) writeFileSync(join(userAgentsDir, file), content);
	const projectAgentsDir = join(cwd, ".claude/agents");
	if (opts.projectAgents) mkdirSync(projectAgentsDir, { recursive: true });
	for (const [file, content] of Object.entries(opts.projectAgents ?? {})) writeFileSync(join(projectAgentsDir, file), content);
	// The same extension, pointed at the temp user agents folder.
	const extensionPath = join(root, "subagent-extension.ts");
	writeFileSync(
		extensionPath,
		`import { createSubagentExtension } from ${JSON.stringify(join(extensionDir, "index.ts"))};\nexport default createSubagentExtension({ userDir: ${JSON.stringify(userAgentsDir)} }, { hcBin: ${JSON.stringify(fakeHcBin)} });\n`,
	);

	const api = `faux-subagent-${worldCount++}`;
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				bifrost: {
					baseUrl: "http://faux.invalid",
					api,
					apiKey: "faux",
					models: MODEL_IDS.map((id) => ({ id, name: `faux ${id}`, reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "bifrost",
			defaultModel: MODEL_ID,
			retry: { enabled: false },
			defaultProjectTrust: opts.trustedProject ? "always" : "never",
			extensions: [extensionPath, probePath, ...(opts.askTools ? [askToolsPath] : [])],
			defaultTools: ["+codemode"],
			skills: [],
		}),
	);
	if (opts.appendSystem) writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), opts.appendSystem);
	writeFileSync(join(agentDir, "AGENTS.md"), "RULE-MARKER: the user's rules.\n");
	if (opts.mcp) {
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcpServerPath], env: { FIXTURE_PIDFILE: pidFile } } } }));
	}

	if (opts.askTools) process.env.SUBAGENT_TEST_ASK_TOOLS = opts.askTools.join(",");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Where transcripts go when the orchestrator has no session file: never the real home.
	process.env.XDG_STATE_HOME = join(root, "state");
	// Where worktrees go (and git-guard looks): never the real ~/.local/state/subagent.
	const worktreeBase = join(root, "subagent-state");
	process.env.SUBAGENT_STATE_DIR = worktreeBase;
	if (opts.git) {
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore" });
		git("init", "-q");
		writeFileSync(join(cwd, "README"), "base\n");
		git("add", "README");
		git("commit", "-q", "-m", "base");
	}
	if (opts.untrustedProject) process.env.UNTRUSTED_EXTENSION_MARKER = untrustedMarker;

	// --- the scripted model -------------------------------------------------------------
	const faux = registerFauxProvider({ api, provider: "bifrost", models: MODEL_IDS.map((id) => ({ id, reasoning: true })) });
	let parentCalls: Array<{ name: string; args: any }> = [];
	/** The texts of the messages that started a parent turn other than the test's own "go", e.g. a subagent's finish notice. */
	const parentNotices: string[] = [];
	const parentToolNames: string[][] = [];
	let childStarts = 0;

	const text = (m: any): string => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join(""));
	const route = (context: any) => {
		const tools = getCurrentTools(context.messages).map((t) => t.name);
		const msgs = context.messages.filter((m: any) => m.role !== "system");
		const last = msgs[msgs.length - 1];
		if (tools.includes("agent")) {
			parentToolNames.push(tools);
			if (last.role === "toolResult") return fauxAssistantMessage([fauxText("parent done")]);
			if (text(last) !== "go") {
				parentNotices.push(text(last));
				return fauxAssistantMessage([fauxText("parent noted the notice")]);
			}
			return fauxAssistantMessage(
				parentCalls.map((c, i) => fauxToolCall(c.name, c.args, { id: `call_${i}` })),
				{ stopReason: "toolUse" },
			);
		}
		// a child
		if (last.role === "user") childStarts++;
		const prompt = text(msgs.find((m: any) => m.role === "user"));
		const [verb, ...rest] = prompt.split(" ");
		const arg = rest.join(" ");
		// a transcript continued with a new message: report what the model can see
		if (last.role === "user" && msgs.length > 1) {
			return fauxAssistantMessage([fauxText(`continued: ${text(last)} | first: ${prompt} | messages: ${msgs.length}`)]);
		}
		if (last.role === "toolResult") {
			if (verb === "SLOWFAIL") return fauxAssistantMessage([], { stopReason: "error", errorMessage: arg });
			return fauxAssistantMessage([fauxText(text(last))]);
		}
		switch (verb) {
			case "TOOLS":
				return fauxAssistantMessage([fauxText(JSON.stringify(tools))]);
			case "PROMPT":
				return fauxAssistantMessage([fauxText(getCurrentSystemPrompt(context.messages))]);
			case "ASK":
				return fauxAssistantMessage([fauxToolCall("probe_ask", { tag: arg })], { stopReason: "toolUse" });
			case "FAIL":
				return fauxAssistantMessage([], { stopReason: "error", errorMessage: arg });
			case "BASH":
				return fauxAssistantMessage([fauxToolCall("bash", { command: arg })], { stopReason: "toolUse" });
			case "SLOWFAIL":
				return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })], { stopReason: "toolUse" });
			case "GATE":
				return fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${arg}.started; while [ ! -f ${arg}.go ]; do sleep 0.05; done` })], { stopReason: "toolUse" });
			case "PING":
				return fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.mcp__fixture__ping({})" })], { stopReason: "toolUse" });
			case "FETCH":
				return fauxAssistantMessage([fauxToolCall("fetch", JSON.parse(arg))], { stopReason: "toolUse" });
			case "HOLD":
				return fauxAssistantMessage([fauxToolCall("bash", { command: `sleep 300 & echo $! > ${arg}.pid; touch ${arg}; wait` })], { stopReason: "toolUse" });
			default:
				return fauxAssistantMessage([fauxText(`done: ${arg}`)]);
		}
	};
	faux.setResponses(Array.from({ length: 300 }, () => route as any));

	// --- the orchestrator session ----------------------------------------------------------
	const world = { dialogs: [] as Dialog[], answer: opts.answer };
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: !!opts.trustedProject });
	const openSession = async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [createCodemodeExtension()] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: opts.persist ? SessionManager.create(cwd, join(root, "sessions")) : SessionManager.inMemory(cwd) });
		await session.bindExtensions({ uiContext: recordingUI(world), mode: "rpc" });
		return session;
	};
	let session = await openSession();

	const mcpPids = () =>
		readFileSync(pidFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(Number);
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	return {
		root,
		/** The temp user agents folder, for tests that edit a definition between calls. */
		userAgentsDir,
		agentDir,
		cwd,
		/** Base for transcripts of an orchestrator with no session file. */
		stateDir: join(root, "state"),
		/** `$SUBAGENT_STATE_DIR` for this world: worktrees are under `<it>/worktrees/`. */
		subagentStateDir: worktreeBase,
		/** The current orchestrator session: another one after `switchSession`. */
		get session() {
			return session;
		},
		/**
		 * What `/new`, `/resume`, `/fork` and a reload do: the old session's extensions get `session_shutdown`
		 * with that reason, then a new session loads the extensions again. The orchestrator process lives on.
		 */
		async switchSession(reason: "new" | "resume" | "fork" | "reload" = "new") {
			const old = session;
			await old.extensionRunner.emit({ type: "session_shutdown", reason });
			session = await openSession();
			old.dispose();
		},
		dialogs: world.dialogs,
		untrustedMarkerExists: () => existsSync(untrustedMarker),
		/** Tool names the parent's model was offered, per request. */
		parentToolNames,
		/** Child sessions that have sent a first request to the model so far. */
		childCount: () => childStarts,
		/** MCP fixture servers started so far, and which are still running. */
		mcp: { started: mcpPids, running: () => mcpPids().filter(alive) },

		/** The fake `hc` (with `herdr: true`, or after a test sets HC_TERMINAL_ID itself). */
		herdr: {
			/** Every recorded `hc` call, optionally only of one command. */
			calls: (cmd?: string): any[] =>
				readFileSync(join(hcDir, "calls.jsonl"), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
					.filter((c) => !cmd || c.cmd === cmd),
			/** Make every later `hc run` fail. */
			failRuns: () => writeFileSync(join(hcDir, "fail-run"), ""),
			/** Move a terminal (named by the subagent id) to a status and turn. */
			set: (name: string, state: { status: string; turn: number }) => writeFileSync(join(hcDir, `term-${name}.json`), JSON.stringify(state)),
			/** The session file the child was launched with. */
			session(name: string): string {
				const run = this.calls("run").find((c) => c.name === name);
				const argv: string[] = run.argv;
				return argv[argv.indexOf("--session") + 1];
			},
			/** The child answers: append an assistant message to its session file, then report `done` at `turn`. */
			finish(name: string, text: string, turn: number, extra: object = {}) {
				const file = this.session(name);
				appendFileSync(file, `${JSON.stringify({ type: "message", id: `m${turn}`, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra } })}\n`);
				this.set(name, { status: "done", turn });
			},
		},

		/** Have the parent call `agent` once per entry, all in one message. */
		start(calls: AgentCall[]): Run {
			return this.startTools(calls.map((c) => ({ name: "agent", args: { subagent_type: "general-purpose", ...c } })));
		},
		/** Have the parent call any tools (`agent_send`, ...) once per entry, all in one message. */
		startTools(calls: Array<{ name: string; args: any }>): Run {
			parentCalls = calls;
			const byId = new Map<string, CallResult>();
			const updatesById = new Map<string, any[]>();
			const unsubscribe = session.subscribe((e: any) => {
				if (e.type === "tool_execution_update") {
					updatesById.set(e.toolCallId, [...(updatesById.get(e.toolCallId) ?? []), e.partialResult?.details]);
				}
				if (e.type === "tool_execution_end") {
					byId.set(e.toolCallId, { isError: !!e.isError, text: (e.result?.content ?? []).map((c: any) => c.text ?? "").join(""), details: e.result?.details });
				}
			});
			const done = session.prompt("go", { expandPromptTemplates: false }).finally(unsubscribe);
			return { done, results: () => calls.map((_, i) => byId.get(`call_${i}`)!), updates: (i) => updatesById.get(`call_${i}`) ?? [] };
		},
		/** One parent turn calling a single tool; resolves to its result. */
		async tool(name: string, args: any): Promise<CallResult> {
			const r = this.startTools([{ name, args }]);
			await r.done;
			return r.results()[0];
		},
		/** Texts of parent turns started by something other than the test (a subagent's finish notice). */
		parentNotices,
		async run(calls: AgentCall[]) {
			const r = this.start(calls);
			await r.done;
			return { results: r.results(), updates: r.updates };
		},
		/** Stop the parent's turn: this fires the signal of every running `agent` call. */
		abort: () => session.abort(),

		async close() {
			// The orchestrator exits: background subagents end with it and give their concurrency slots back.
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
			await session.abort().catch(() => {});
			session.dispose();
			faux.unregister();
		},
	};
}

export type World = Awaited<ReturnType<typeof createWorld>>;

/** The pid of the `sleep 300` a HOLD child started, once its marker exists. */
export const holdPid = (marker: string) => Number(readFileSync(`${marker}.pid`, "utf8").trim());

/**
 * Whether this exact process still runs. Test files run in parallel and each starts its own `sleep 300`,
 * so a machine-wide `pgrep` would count theirs. A zombie counts as gone: it is dead, only not yet reaped.
 */
export function isRunning(pid: number): boolean {
	try {
		return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
	} catch {
		return false;
	}
}

export async function waitFor(cond: () => boolean, what: string, ms = 10_000) {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}
