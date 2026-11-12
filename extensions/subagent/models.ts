// Model resolver: turns the requested model (call parameter, else the definition's `model:`,
// else `inherit`) and thinking level (call parameter, else the definition's `thinking:`, else the
// orchestrator's) into a concrete pair, or an error listing the known ids or levels.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

/** The slice of pi's ModelRegistry the resolver reads. `getAvailable()` is the models with auth configured. */
export interface ModelSource {
	getAvailable(): Model<any>[];
}

export interface ResolveModelInput {
	/** The call's `model` parameter. Wins over the definition's. */
	requested?: string;
	/** The agent definition's `model:`. */
	definitionModel?: string;
	/** The orchestrator's current model and thinking level: what `inherit` and a missing value give. */
	orchestrator: { model: Model<any>; thinkingLevel: ThinkingLevel };
	registry: ModelSource;
	/** The call's `thinking` parameter. Wins over the definition's. */
	requestedThinking?: string;
	/** The agent definition's `thinking:`. */
	definitionThinking?: string;
}

export type ResolvedModel = { ok: true; model: Model<any>; thinkingLevel: ThinkingLevel } | { ok: false; error: string };

/** Claude Code's aliases map to the Claude subscription models Bifrost serves, ids `claude-sub/claude-<alias>-<version>`. */
export const ALIASES = ["sonnet", "opus", "haiku"] as const;
const ALIAS_PROVIDER = "bifrost";

/** pi's thinking levels, as `ThinkingLevel` in pi-agent-core. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

/** `provider/id` as the user writes it. */
const ref = (m: Model<any>) => `${m.provider}/${m.id}`;

export function resolveModel(input: ResolveModelInput): ResolvedModel {
	const { orchestrator, registry } = input;
	const wanted = (input.requested?.trim() || input.definitionModel?.trim() || "inherit");
	// Thinking level: the call's, else the definition's, else the orchestrator's (`inherit` too). pi clamps it to what
	// the chosen model supports when the session is created.
	const level = input.requestedThinking?.trim() || input.definitionThinking?.trim() || "inherit";
	if (level !== "inherit" && !(THINKING_LEVELS as readonly string[]).includes(level)) {
		return { ok: false, error: `Unknown thinking level "${level}". Valid levels: ${[...THINKING_LEVELS, "inherit"].join(", ")}` };
	}
	const thinkingLevel = level === "inherit" ? orchestrator.thinkingLevel : (level as ThinkingLevel);
	const inherit = (model: Model<any>): ResolvedModel => ({ ok: true, model, thinkingLevel });
	if (wanted === "inherit") return inherit(orchestrator.model);

	const known = registry.getAvailable();
	if ((ALIASES as readonly string[]).includes(wanted)) {
		const prefix = `claude-sub/claude-${wanted}-`;
		// Highest version wins when Bifrost lists several.
		const match = known
			.filter((m) => m.provider === ALIAS_PROVIDER && m.id.startsWith(prefix))
			.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
		if (match) return inherit(match);
		return fail(`No ${ALIAS_PROVIDER} subscription model for "${wanted}"`, known);
	}

	// A full ref `provider/id` (split at the first slash: ids such as `icr-qwen/qwen3.8` contain one themselves).
	const slash = wanted.indexOf("/");
	if (slash > 0) {
		const full = known.find((m) => m.provider === wanted.slice(0, slash) && m.id === wanted.slice(slash + 1));
		if (full) return inherit(full);
	}
	// A bare id with no provider. If several providers carry it, the orchestrator's own provider wins, else it is ambiguous.
	const bare = known.filter((m) => m.id === wanted);
	if (bare.length === 1) return inherit(bare[0]);
	if (bare.length > 1) {
		const own = bare.find((m) => m.provider === orchestrator.model.provider);
		if (own) return inherit(own);
		return { ok: false, error: `Model "${wanted}" is ambiguous. Use one of: ${bare.map(ref).join(", ")}` };
	}
	return fail(`Unknown model "${wanted}"`, known);
}

function fail(what: string, known: Model<any>[]): ResolvedModel {
	return { ok: false, error: `${what}. Known models: ${[...ALIASES, "inherit", ...known.map(ref)].join(", ")}` };
}
