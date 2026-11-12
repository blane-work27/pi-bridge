// Test-only extension. Before a tool named in SUBAGENT_TEST_ASK_TOOLS (comma separated) runs, it asks the
// user with ctx.ui.confirm, and it blocks the call when the user declines or there is no UI.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const names = (process.env.SUBAGENT_TEST_ASK_TOOLS ?? "").split(",").filter(Boolean);
		if (!names.includes(event.toolName)) return undefined;
		if (!ctx.hasUI) return { block: true, reason: `${event.toolName} needs the user's approval, and this session has no UI.` };
		const ok = await ctx.ui.confirm(`Allow ${event.toolName}?`, `${event.toolName} ${JSON.stringify(event.input ?? {}).slice(0, 400)}`);
		return ok ? undefined : { block: true, reason: "The user declined this call." };
	});
}
