// Agent definitions: the markdown files Claude Code reads, plus the built-ins.
//
// Sources, lowest to highest precedence: built-ins, the user's agents folder, and (trusted
// projects only) the project's `.claude/agents/`. Files are re-read on every call, so an edit
// takes effect without a restart.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentDefinition {
	name: string;
	description: string;
	/** Appended to the child's system prompt. */
	systemPrompt: string;
	/** The definition's `model:` value, unresolved (see models.ts). `inherit` means the orchestrator's model. */
	model: string;
	/** The definition's `thinking:` value, unvalidated (see models.ts). Unset inherits the orchestrator's level. */
	thinking?: string;
	/** The definition's `tools:` entries as written (Claude Code names). Undefined inherits the orchestrator's tools. */
	tools?: string[];
	source: "builtin" | "user" | "project";
}

export interface ResolvedAgent extends AgentDefinition {
	/** The tool names the child gets, in pi's names. */
	toolList: string[];
	/** Tool names the definition asked for that pi (here) lacks. */
	dropped: string[];
	/** Whether the child gets the MCP extension: see `wantsMcp`. */
	mcp: boolean;
}

/**
 * MCP servers cost a process each and seconds of startup, so only a definition that can use them
 * gets them: one with no `tools:` line (it inherits the orchestrator's MCP tools, which are
 * reached through codemode) or one that names an MCP tool, `mcp__<server>__<tool>`. `codemode`
 * alone does not count: a narrowed list that merely names it has not asked for MCP. A server
 * or wildcard entry (`mcp__gitlab`, `mcp__gitlab__*`) does not count either: pi's tool list takes
 * exact names and the server's tools are unknown until it has started.
 */
const isMcpToolName = (t: string) => /^mcp__[^_].*?__[^*]+$/.test(t);

export function wantsMcp(def: Pick<AgentDefinition, "tools">): boolean {
	return !def.tools || def.tools.some(isMcpToolName);
}

export interface AgentFolders {
	/** The user's Claude agents folder. Default `~/.claude/agents`. */
	userDir?: string;
	/** The project's agents folder, given the cwd. Default `<cwd>/.claude/agents`. */
	projectDir?: (cwd: string) => string;
}

/**
 * The pi tool name a `WebFetch` entry maps to. The orchestrator has no such tool: a child whose
 * definition lists WebFetch gets it registered in its own session (fetch.ts), so it is always
 * available to resolve against.
 */
export const FETCH_TOOL = "fetch";

/** Claude Code tool name to pi tool names. */
export const TOOL_MAP: Record<string, string[]> = {
	Read: ["read"],
	Grep: ["grep"],
	Glob: ["find"],
	LS: ["ls"],
	Bash: ["bash"],
	Edit: ["edit"],
	MultiEdit: ["edit"],
	Write: ["write"],
	WebFetch: [FETCH_TOOL],
};

export const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "general-purpose",
		description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
		systemPrompt: "",
		model: "inherit",
		source: "builtin",
	},
	{
		name: "Explore",
		description:
			"Read-only search agent for broad fan-out searches: when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It locates code; it doesn't review or audit it. Specify search breadth: \"medium\" for moderate exploration, \"very thorough\" for multiple locations and naming conventions.",
		systemPrompt:
			"You are a read-only search agent. Never modify files: use bash only for read-only commands such as git log, git diff, git show or rg, never to write, move or delete anything. Search broadly, read excerpts rather than whole files, and report the conclusion with file paths and line numbers, not file dumps.",
		model: "haiku",
		tools: ["read", "grep", "find", "ls", "bash"],
		source: "builtin",
	},
];

const asList = (v: unknown): string[] | undefined => {
	if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
	if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
	return undefined;
};

function readFolder(dir: string, source: "user" | "project"): AgentDefinition[] {
	if (!existsSync(dir)) return [];
	const out: AgentDefinition[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".md")) continue;
		try {
			const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(dir, file), "utf8"));
			const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : basename(file, ".md");
			const description = typeof fm.description === "string" ? fm.description.trim() : "";
			const tools = asList(fm.tools);
			const thinking = typeof fm.thinking === "string" ? fm.thinking.trim() : "";
			out.push({
				name,
				description: description || name,
				systemPrompt: body.trim(),
				model: typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : "inherit",
				...(thinking ? { thinking } : {}),
				...(tools && !(tools.length === 1 && tools[0] === "*") ? { tools } : {}),
				source,
			});
		} catch {
			// an unreadable or malformed file is skipped, as Claude Code does
		}
	}
	return out;
}

/** All available agents by name: built-ins, then user, then project (trusted projects only). */
export function listAgents(opts: { cwd: string; trusted: boolean; folders?: AgentFolders }): AgentDefinition[] {
	const userDir = opts.folders?.userDir ?? join(homedir(), ".claude", "agents");
	const projectDir = (opts.folders?.projectDir ?? ((cwd: string) => join(cwd, ".claude", "agents")))(opts.cwd);
	const byName = new Map<string, AgentDefinition>();
	const layers = [BUILTIN_AGENTS, readFolder(userDir, "user"), opts.trusted ? readFolder(projectDir, "project") : []];
	for (const layer of layers) for (const a of layer) byName.set(a.name, a);
	return [...byName.values()];
}

/**
 * Turn a definition into the child's tool list. `inherited` is the orchestrator's tool set minus
 * what a subagent never gets. A `tools:` line narrows it; names pi lacks are dropped, and the
 * system prompt says so.
 */
export function resolveAgent(def: AgentDefinition, inherited: string[]): ResolvedAgent {
	const mcp = wantsMcp(def);
	if (!def.tools) return { ...def, toolList: inherited, dropped: [], mcp };
	const wanted = new Set<string>();
	const dropped: string[] = [];
	for (const entry of def.tools) {
		// MCP tools are registered after the child starts, so they are never in the inherited list: keep the name, and
		// add codemode, the only way to call them.
		if (isMcpToolName(entry)) {
			wanted.add(entry);
			if (inherited.includes("codemode")) wanted.add("codemode");
			continue;
		}
		const mapped = TOOL_MAP[entry] ?? [entry];
		const have = mapped.filter((t) => inherited.includes(t) || t === FETCH_TOOL);
		if (have.length) have.forEach((t) => wanted.add(t));
		else dropped.push(entry);
	}
	const toolList = [...inherited.filter((t) => wanted.has(t)), ...[...wanted].filter((t) => !inherited.includes(t))];
	const note = dropped.length
		? `\n\nNote: these tools from your definition are not available in this environment: ${dropped.join(", ")}. Work without them.`
		: "";
	return { ...def, systemPrompt: (def.systemPrompt + note).trim(), toolList, dropped, mcp };
}
