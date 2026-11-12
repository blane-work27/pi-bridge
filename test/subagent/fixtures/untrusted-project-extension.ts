// Lives in a test project's .pi/extensions. Loading it leaves a file behind.
import { writeFileSync } from "node:fs";

export default function () {
	if (process.env.UNTRUSTED_EXTENSION_MARKER) writeFileSync(process.env.UNTRUSTED_EXTENSION_MARKER, "loaded");
}
