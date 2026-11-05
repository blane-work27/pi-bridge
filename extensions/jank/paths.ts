import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function stateDir(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "jank");
}

export const extensionDir = dirname(fileURLToPath(import.meta.url));
