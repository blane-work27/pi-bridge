// Drives git-guard's tools the way pi does: an SDK session on the faux model provider.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const root = realpathSync(mkdtempSync(join(tmpdir(), "git-guard-test-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
export const stateDir = join(root, "subagent-state");
export const worktreeDir = join(stateDir, "worktrees");
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "git-identities.json"), JSON.stringify({ "gitlab.example.test": "tester@example.test" }));
const globalConfig = join(root, "gitconfig");
writeFileSync(globalConfig, "[user]\n\tname = Test User\n");
// A stand-in for ssh: it runs git's remote command here, so `ssh://git@gitlab.example.test/<abs path>`
// pushes to a local bare repo while git-guard still sees the host that has an identity.
const fakeSsh = join(root, "fake-ssh");
writeFileSync(fakeSsh, '#!/bin/sh\nfor a; do last=$a; done\nexec sh -c "$last"\n');
chmodSync(fakeSsh, 0o755);

// git-guard reads these at import time (identities file) or per call (the rest).
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SUBAGENT_STATE_DIR = stateDir;
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_SSH_COMMAND = fakeSsh;
process.env.GIT_SSH_VARIANT = "simple";

const { default: gitGuard } = await import("../../extensions/git-guard/index.ts");

function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let n = 0;
/** A throwaway repo on `branch`, with one staged change. `parent` places it (default: a scratch dir). */
export function makeRepo(branch: string, parent = join(root, "repos")): string {
	mkdirSync(parent, { recursive: true });
	const dir = join(parent, `repo${n++}`);
	mkdirSync(dir);
	sh(dir, "init", "-q", "-b", "main");
	sh(dir, "config", "user.name", "x");
	sh(dir, "config", "user.email", "x@x");
	writeFileSync(join(dir, "a.txt"), "a\n");
	sh(dir, "add", ".");
	// the initial commit has the user's identity, so git_push's outgoing-commit check passes
	sh(dir, "-c", "user.name=Test User", "-c", "user.email=tester@example.test", "commit", "-q", "-m", "init");
	if (branch !== "main") sh(dir, "checkout", "-q", "-b", branch);
	// fetch from a local bare repo, push to the host that has an identity
	const bare = `${dir}.git`;
	sh(root, "init", "-q", "--bare", bare);
	sh(dir, "remote", "add", "origin", bare);
	sh(dir, "config", "remote.origin.pushurl", "git@gitlab.example.test:team/repo.git");
	writeFileSync(join(dir, "a.txt"), `a ${n}\n`);
	sh(dir, "add", ".");
	return dir;
}

/** A bare repo seeded with `dir`'s main, added to `dir` as `name`: fetched from its path, pushed to over (fake) ssh. */
export function addPushableRemote(dir: string, name: string): string {
	const bare = join(root, `${name}-${n++}.git`);
	sh(root, "init", "-q", "--bare", bare);
	sh(dir, "push", "-q", bare, "main");
	if (sh(dir, "remote").split("\n").includes(name)) sh(dir, "remote", "set-url", name, bare);
	else sh(dir, "remote", "add", name, bare);
	sh(dir, "config", `remote.${name}.pushurl`, `ssh://git@gitlab.example.test${bare}`);
	sh(dir, "fetch", "-q", name);
	return bare;
}

export function head(dir: string): string {
	return sh(dir, "rev-parse", "HEAD");
}

export interface Dialog {
	title: string;
	message: string;
}

export interface ToolRun {
	isError: boolean;
	text: string;
	dialogs: Dialog[];
}

/** Have the model call `tool` once in a session rooted at `cwd`, then finish. */
export async function callTool(opts: { cwd: string; tool: string; args: Record<string, unknown>; ui?: boolean; approve?: boolean }): Promise<ToolRun> {
	const faux = createFauxCore({ api: "faux-api", provider: "faux" });
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerProvider("faux", {
		api: "faux-api",
		baseUrl: "http://faux.invalid",
		apiKey: "faux",
		streamSimple: faux.streamSimple as any,
		models: [{ id: "faux-1", name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(opts.tool, opts.args)], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const resourceLoader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [gitGuard],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir,
		modelRuntime,
		model: modelRuntime.getModel("faux", "faux-1"),
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
	});
	const dialogs: Dialog[] = [];
	const uiContext = {
		confirm: async (title: string, message: string) => {
			dialogs.push({ title, message });
			return opts.approve ?? true;
		},
	} as any;
	await session.bindExtensions(opts.ui === false ? {} : { uiContext });
	let result: ToolRun = { isError: true, text: "tool was never called", dialogs };
	session.subscribe((e: any) => {
		if (e.type === "tool_execution_end") {
			const text = (e.result?.content ?? []).map((c: any) => c.text ?? "").join("");
			result = { isError: !!e.isError, text, dialogs };
		}
	});
	try {
		await session.prompt("go");
	} finally {
		session.dispose();
	}
	return result;
}

export const commit = (cwd: string, message = "Add a thing", extra: { ui?: boolean; approve?: boolean } = {}) =>
	callTool({ cwd, tool: "git_commit", args: { message }, ...extra });
