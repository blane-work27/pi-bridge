// Process-wide subagent state. pi re-runs extension factories on /new, /resume, /fork and reload, and
// may or may not share this module between runs, so the state hangs off globalThis (like the
// concurrency semaphore). Each factory run points `pi` at its own session: the registry hands finish
// notices to whichever session is current.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRegistry } from "./backend.ts";

const KEY = Symbol.for("pi-bridge.subagent.shared");

export interface SharedSubagents {
	registry: AgentRegistry;
	/** The newest session's API. */
	pi: ExtensionAPI;
}

/** The shared state, created on first use; `pi` is always set to the caller's. */
export function sharedSubagents(pi: ExtensionAPI, create: () => AgentRegistry): SharedSubagents {
	const g = globalThis as { [KEY]?: SharedSubagents };
	const shared = (g[KEY] ??= { registry: create(), pi });
	shared.pi = pi;
	return shared;
}
