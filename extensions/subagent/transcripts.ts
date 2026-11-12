// Where a subagent's session file goes. The file is an ordinary pi session, so it can be
// reopened later (see `resumeSubagent` in in-process.ts).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Fallback base when the orchestrator has no session file (`--no-session`, in-memory).
 * `$XDG_STATE_HOME` is the injection point for tests.
 */
export function fallbackTranscriptBase(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "subagent/transcripts");
}

/**
 * The directory for one orchestrator session's subagent transcripts: `<orchestrator file minus
 * .jsonl>.subagents/`, beside the orchestrator's own file. It is a subdirectory, so pi's session
 * listing (which reads `*.jsonl` in the session dir) does not show subagents as sessions.
 */
export function transcriptDir(orchestratorSessionFile: string | undefined, fallbackBase: string = fallbackTranscriptBase()): string {
	if (!orchestratorSessionFile) return join(fallbackBase, "unsaved");
	return join(dirname(orchestratorSessionFile), `${basename(orchestratorSessionFile).replace(/\.jsonl$/, "")}.subagents`);
}

/**
 * The text of the last assistant message in a session file (last `type: "message"` entry whose
 * role is `assistant`). `error` is set when that message ended in an error.
 */
export function lastAssistantMessage(file: string): { text: string; error?: string } | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const lines = raw.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i]) continue;
		let entry: any;
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		const text = typeof content === "string" ? content : (content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("");
		return { text, ...(entry.message.stopReason === "error" ? { error: entry.message.errorMessage || "the subagent ended in an error" } : {}) };
	}
	return undefined;
}
