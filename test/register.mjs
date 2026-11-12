// Loaded with `node --import ./test/register.mjs`. pi-bridge has no node_modules,
// so resolve pi's SDK packages from the pi install (PI_SDK_DIR overrides it).
import { register } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

process.env.PI_SDK_DIR ||= join(homedir(), ".local/share/pi-icr/node_modules");
register("./sdk-resolve-hook.mjs", import.meta.url);
