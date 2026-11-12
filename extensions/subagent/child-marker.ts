// Marks code running while a subagent's session is being set up, so the extension can refuse to
// register itself inside a subagent (no nesting).
//
// The child's resource loader loads the same settings.json extensions as the parent, this one
// included. Its factory runs inside `runAsSubagent`, and sees the mark. The store sits on globalThis
// because pi may load a second copy of this module for the child.
import { AsyncLocalStorage } from "node:async_hooks";

const KEY = Symbol.for("pi-subagent.child-marker");
type Store = AsyncLocalStorage<true>;

function store(): Store {
	const g = globalThis as { [KEY]?: Store };
	return (g[KEY] ??= new AsyncLocalStorage<true>());
}

export function runAsSubagent<T>(fn: () => T): T {
	return store().run(true, fn);
}

export function insideSubagent(): boolean {
	return store().getStore() === true;
}
