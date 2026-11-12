// Test-only extension, listed in the test agentDir's settings so that parent and child both load it.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const probeAsk = defineTool({
	name: "probe_ask",
	label: "probe ask",
	description: "Raise an approval dialog and report the answer.",
	parameters: Type.Object({ tag: Type.String() }),
	async execute(_id, params, _signal, _onUpdate, ctx) {
		const ok = await ctx.ui.confirm(`Allow ${params.tag}?`, `probe ${params.tag}`);
		return { content: [{ type: "text", text: `${params.tag} ${ok ? "approved" : "denied"}` }], details: undefined };
	},
});

// Stands in for jank: an active tool whose name the subagent must never inherit.
const jankFake = defineTool({
	name: "jank_fake",
	label: "jank fake",
	description: "Stand-in for a jank tool.",
	parameters: Type.Object({}),
	async execute() {
		return { content: [{ type: "text", text: "jank" }], details: undefined };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(probeAsk);
	pi.registerTool(jankFake);
}
