import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const DIALOGS = new Set<string | symbol>(["confirm", "select", "input"]);

/**
 * A view of the orchestrator's UI for one subagent: its dialogs show up in the orchestrator's pane
 * with the title prefixed, and the answer comes back to the caller that asked. Everything else
 * passes through. Pi spreads the UI object it is given, so this reads through a Proxy on `get`
 * only and leaves the target's own keys alone.
 */
export function labelDialogs(ui: ExtensionUIContext, label: string): ExtensionUIContext {
	return new Proxy(ui, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			if (DIALOGS.has(prop)) return (title: string, ...rest: unknown[]) => value.call(target, `[${label}] ${title}`, ...rest);
			return value.bind(target);
		},
	});
}
