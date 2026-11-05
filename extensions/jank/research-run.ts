import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TIMEOUT_MS = 60 * 60 * 1000;

const dir = process.argv[2];
if (!dir) {
	console.error("usage: research-run.ts <run dir>");
	process.exit(2);
}

const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
const startedAt = new Date().toISOString();
const progressFile = join(dir, "progress.log");
const orchestratorPrompt = resolve(request.extensionDir, "..", "..", "skills", "jank-research", "orchestrator.md");

function status(s: Record<string, unknown>): void {
	writeFileSync(join(dir, "status.json"), JSON.stringify({ startedAt, pid: process.pid, ...s }, null, 2));
}

function progress(line: string): void {
	appendFileSync(progressFile, `${new Date().toISOString().slice(11, 19)} ${line.replace(/\s+/g, " ").slice(0, 300)}\n`);
}

function answerOf(doc: string): string {
	const m = doc.match(/^##\s+Answer\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
	const body = (m ? m[1] : doc).trim();
	return body.length > 1500 ? `${body.slice(0, 1500)}…` : body;
}

status({ state: "running" });
progress(`started: ${request.question}`);

const prompt = `Question: ${request.question}

Brief from the session that asked:
${request.brief}

Working directory: ${request.cwd}

Follow your research instructions. Your last message must be the complete Markdown document and nothing else.`;

const [cmd, ...pre] = request.pi;
const args = [
	...pre,
	"--mode",
	"json",
	"-p",
	"--no-session",
	"--model",
	`bifrost/${request.orchestratorModel}`,
	"--no-extensions",
	"-e",
	"builtin:codemode",
	"-e",
	join(request.extensionDir, "index.ts"),
	"-e",
	join(request.extensionDir, "..", "git-guard", "index.ts"),
	"--no-skills",
	"--no-prompt-templates",
	"--tools",
	"-bash,-edit,-write,+grep,+find,+ls,+codemode",
	"--append-system-prompt",
	orchestratorPrompt,
	prompt,
];

const child = spawn(cmd, args, {
	cwd: request.cwd,
	env: { ...process.env, JANK_ROLE: "research", PI_TELEMETRY: "0" },
	stdio: ["ignore", "pipe", "pipe"],
});

let buf = "";
let finalText = "";
let error = "";
let stderr = "";

function handle(line: string): void {
	if (!line.trim()) return;
	let ev: any;
	try {
		ev = JSON.parse(line);
	} catch {
		return;
	}
	if (ev.type === "message_end" && ev.message?.role === "assistant") {
		const t = (ev.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		if (t.trim()) {
			finalText = t;
			progress(`orchestrator: ${t.slice(0, 200)}`);
		}
		if (ev.message.stopReason === "error") error = ev.message.errorMessage || "The orchestrator stopped with an error.";
		else error = "";
	} else if (ev.type === "tool_execution_start") {
		const detail = ev.toolName === "codemode" ? `script (${String(ev.args?.code ?? ev.args?.script ?? "").length} chars)` : JSON.stringify(ev.args ?? {});
		progress(`tool ${ev.toolName}: ${detail}`);
	} else if (ev.type === "tool_execution_update" && ev.parentToolCallId) {
		const t = ev.partialResult?.content?.find((c: any) => c.type === "text")?.text;
		if (t) progress(`  ${t}`);
	} else if (ev.type === "tool_execution_end") {
		progress(`tool ${ev.toolName} ${ev.isError ? "failed" : "done"}${ev.durationMs ? ` in ${Math.round(ev.durationMs / 1000)}s` : ""}`);
	}
}

child.stdout.on("data", (d: Buffer) => {
	buf += d.toString("utf8");
	let i: number;
	while ((i = buf.indexOf("\n")) >= 0) {
		handle(buf.slice(0, i));
		buf = buf.slice(i + 1);
	}
});
child.stderr.on("data", (d: Buffer) => {
	if (stderr.length < 20000) stderr += d.toString("utf8");
});

const timer = setTimeout(() => {
	error = "The research run timed out after 60 minutes.";
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), 5000).unref();
}, TIMEOUT_MS);

child.on("close", (code) => {
	clearTimeout(timer);
	if (buf) handle(buf);
	if (stderr.trim()) appendFileSync(join(dir, "stderr.log"), stderr);
	const doc = finalText.trim();
	if (error || !doc || !doc.includes("#")) {
		const reason = error || (doc ? "The orchestrator did not return a Markdown document." : `The orchestrator returned nothing (exit ${code}).`);
		if (doc) writeFileSync(join(dir, "partial.md"), doc);
		progress(`failed: ${reason}`);
		status({ state: "failed", error: reason, finishedAt: new Date().toISOString() });
		process.exit(1);
	}
	writeFileSync(request.out, `${doc}\n`);
	progress(`done: ${request.out}`);
	status({ state: "done", out: request.out, answer: answerOf(doc), finishedAt: new Date().toISOString() });
	process.exit(0);
});
