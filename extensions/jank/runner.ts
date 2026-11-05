import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { extensionDir } from "./paths.ts";

export const DEFAULT_MODEL = "icr-gpt56-luna/gpt-5.6-luna";
export const READ_TOOLS = ["read", "grep", "find", "ls"];
export const WRITE_TOOLS = ["edit", "write"];
const ALLOWED_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS, "bash", "jank_fetch"]);
const MAX_ATTEMPTS = 3;

const WORKER_PROMPT = `You are a worker agent. Another agent gave you one task. Do only that task.
Work from evidence: read files and sources before you make claims about them. Cite file paths with line numbers, or URLs.
Do not ask questions. Nobody reads them. If something blocks you, say what blocks you in your answer.
Do not run git commit, git push, or any command that changes git history.
Do not install packages.
Keep your final answer short and specific. It is read by a program or another agent, not a person.`;

class Semaphore {
	private active = 0;
	private queue: (() => void)[] = [];
	constructor(private limit: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

const limit = Math.min(16, Math.max(1, Number(process.env.JANK_CONCURRENCY) || 4));
export const workers = new Semaphore(limit);

function knownModels(): Set<string> {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (!dir) return new Set();
	try {
		const m = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
		return new Set((m.providers?.bifrost?.models ?? []).map((x: any) => String(x.id)));
	} catch {
		return new Set();
	}
}

export function resolveModel(model: string | undefined): string {
	const id = (model || DEFAULT_MODEL).replace(/^bifrost\//, "");
	if (!/^icr-[a-z0-9-]+\/\S+$/.test(id)) {
		throw new Error(`Worker model "${id}" is not a gateway model. jank workers must use an icr-* model, for example ${DEFAULT_MODEL}.`);
	}
	const known = knownModels();
	if (known.size && !known.has(id)) {
		throw new Error(`Worker model "${id}" is not in models.json. Known gateway models: ${[...known].filter((k) => k.startsWith("icr-")).join(", ")}`);
	}
	return id;
}

export function resolveTools(tools: string[] | undefined, writable: boolean): string[] {
	const list = tools && tools.length ? tools : writable ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
	for (const t of list) if (!ALLOWED_TOOLS.has(t)) throw new Error(`Tool "${t}" is not allowed for workers. Allowed: ${[...ALLOWED_TOOLS].join(", ")}`);
	return [...new Set(list)];
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface WorkerRun {
	ok: boolean;
	text: string;
	data?: unknown;
	error?: string;
	stopReason?: string;
	attempts: number;
	usage: Usage;
	durationMs: number;
	toolCalls: number;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addUsage(a: Usage, b: any): void {
	if (!b) return;
	a.input += b.input ?? 0;
	a.output += b.output ?? 0;
	a.cacheRead += b.cacheRead ?? 0;
	a.cacheWrite += b.cacheWrite ?? 0;
	a.totalTokens += b.totalTokens ?? 0;
}

function piCommand(): [string, string[]] {
	if (process.env.JANK_PI_BIN) return [process.env.JANK_PI_BIN, []];
	return [process.execPath, [process.argv[1]]];
}

interface Attempt {
	text: string;
	submitted?: unknown;
	submitError?: string;
	stopReason?: string;
	errorMessage?: string;
	usage: Usage;
	toolCalls: number;
	exitCode: number | null;
	stderr: string;
}

function runOnce(opts: {
	prompt: string;
	model: string;
	tools: string[];
	cwd: string;
	schemaFile?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	onEvent?: (msg: string) => void;
}): Promise<Attempt> {
	const [cmd, pre] = piCommand();
	const tools = [...opts.tools];
	if (opts.schemaFile) tools.push("submit");
	const args = [
		...pre,
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		`bifrost/${opts.model}`,
		"--no-extensions",
		"-e",
		join(extensionDir, "worker.ts"),
		"-e",
		join(extensionDir, "..", "git-guard", "index.ts"),
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--tools",
		tools.join(","),
		"--append-system-prompt",
		WORKER_PROMPT,
		opts.prompt,
	];
	const env: Record<string, string | undefined> = { ...process.env, PI_TELEMETRY: "0", JANK_ROLE: "worker" };
	delete env.JANK_SCHEMA_FILE;
	if (opts.schemaFile) env.JANK_SCHEMA_FILE = opts.schemaFile;
	env.JANK_FETCH = tools.includes("jank_fetch") ? "1" : "0";
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		const result: Attempt = { text: "", usage: emptyUsage(), toolCalls: 0, exitCode: null, stderr: "" };
		let buf = "";
		const handle = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const m = ev.message;
				addUsage(result.usage, m.usage);
				const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
				if (text.trim()) result.text = text;
				result.stopReason = m.stopReason;
				if (m.errorMessage) result.errorMessage = m.errorMessage;
			} else if (ev.type === "tool_execution_start") {
				result.toolCalls++;
				opts.onEvent?.(`${ev.toolName} ${JSON.stringify(ev.args ?? {}).slice(0, 120)}`);
			} else if (ev.type === "tool_execution_end" && ev.toolName === "submit") {
				if (ev.isError) {
					const t = ev.result?.content?.find((c: any) => c.type === "text")?.text;
					result.submitError = t ?? "submit failed";
				} else {
					result.submitted = ev.result?.details;
					result.submitError = undefined;
				}
			}
		};
		child.stdout.on("data", (d: Buffer) => {
			buf += d.toString("utf8");
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				handle(buf.slice(0, i));
				buf = buf.slice(i + 1);
			}
		});
		child.stderr.on("data", (d: Buffer) => {
			if (result.stderr.length < 8000) result.stderr += d.toString("utf8");
		});
		const kill = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		};
		const timer = setTimeout(() => {
			result.errorMessage = `Worker timed out after ${Math.round(opts.timeoutMs / 1000)}s`;
			kill();
		}, opts.timeoutMs);
		const onAbort = () => {
			result.errorMessage = "Worker aborted";
			kill();
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (e) => {
			result.errorMessage = `Could not start pi: ${e.message}`;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (buf) handle(buf);
			result.exitCode = code;
			resolve(result);
		});
	});
}

function extractJson(text: string): unknown {
	const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	const candidates = [fence?.[1], text.trim()];
	const first = text.search(/[{[]/);
	if (first >= 0) candidates.push(text.slice(first, Math.max(text.lastIndexOf("}"), text.lastIndexOf("]")) + 1));
	for (const c of candidates) {
		if (!c) continue;
		try {
			return JSON.parse(c);
		} catch {}
	}
	throw new Error("The answer is not JSON.");
}

function validate(schema: any, value: unknown): unknown {
	return validateToolArguments({ name: "submit", description: "", parameters: schema } as any, {
		type: "toolCall",
		id: "jank",
		name: "submit",
		arguments: value,
	} as any);
}

export async function runWorker(opts: {
	prompt: string;
	model: string;
	tools: string[];
	cwd: string;
	schema?: object;
	timeoutMs: number;
	signal?: AbortSignal;
	onEvent?: (msg: string) => void;
}): Promise<WorkerRun> {
	const started = Date.now();
	const usage = emptyUsage();
	let toolCalls = 0;
	let schemaDir: string | undefined;
	let schemaFile: string | undefined;
	if (opts.schema) {
		schemaDir = mkdtempSync(join(tmpdir(), "jank-schema-"));
		schemaFile = join(schemaDir, `${randomBytes(4).toString("hex")}.json`);
		writeFileSync(schemaFile, JSON.stringify(opts.schema));
	}
	try {
		let prompt = opts.prompt;
		if (opts.schema) {
			prompt += `\n\nWhen you are done, call the submit tool once with your answer. Its arguments must match this JSON Schema:\n${JSON.stringify(opts.schema)}`;
		}
		let last: Attempt | undefined;
		let problem = "";
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (opts.signal?.aborted) break;
			const p = problem ? `${prompt}\n\nA previous attempt at this task failed: ${problem}\nDo the task again and fix that.` : prompt;
			last = await runOnce({ ...opts, prompt: p, schemaFile });
			addUsage(usage, last.usage);
			toolCalls += last.toolCalls;
			const base = { attempts: attempt, usage, durationMs: Date.now() - started, toolCalls, stopReason: last.stopReason };
			if (last.errorMessage && /timed out|aborted|Could not start/.test(last.errorMessage)) {
				return { ok: false, text: last.text, error: last.errorMessage, ...base };
			}
			if (last.stopReason === "error" || (last.exitCode !== 0 && !last.text && last.submitted === undefined)) {
				problem = last.errorMessage || last.stderr.trim().split("\n").slice(-3).join(" ") || `pi exited with code ${last.exitCode}`;
				continue;
			}
			if (!opts.schema) return { ok: true, text: last.text, ...base };
			if (last.submitted !== undefined) return { ok: true, text: last.text, data: last.submitted, ...base };
			try {
				const data = validate(opts.schema, extractJson(last.text));
				return { ok: true, text: last.text, data, ...base };
			} catch (e: any) {
				problem = last.submitError
					? `submit was rejected: ${last.submitError.slice(0, 1500)}`
					: `you did not call the submit tool, and your text answer did not match the schema (${String(e.message).slice(0, 800)}). You must call submit.`;
			}
		}
		return {
			ok: false,
			text: last?.text ?? "",
			error: problem || "The worker did not finish.",
			attempts: MAX_ATTEMPTS,
			usage,
			durationMs: Date.now() - started,
			toolCalls,
			stopReason: last?.stopReason,
		};
	} finally {
		if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
	}
}
