// A definition's body is added to pi-bridge's system prompt addendum, in-process and in a Herdr terminal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { createWorld } from "./harness.ts";

const reader = { "reader.md": "---\nname: reader\ndescription: reads\ntools: Read\n---\nBODY-MARKER you only read.\n" };

describe("a definition body keeps the pi-bridge addendum", () => {
	test("in-process: the child's system prompt has the addendum and the body", async () => {
		const w = await createWorld({ appendSystem: "ADDENDUM-MARKER pi-bridge rules", userAgents: reader });
		try {
			const { results } = await w.run([{ description: "p", prompt: "PROMPT", subagent_type: "reader" }]);
			assert.match(results[0].text, /ADDENDUM-MARKER/);
			assert.match(results[0].text, /BODY-MARKER/);
			assert.ok(results[0].text.indexOf("ADDENDUM-MARKER") < results[0].text.indexOf("BODY-MARKER"));
		} finally {
			await w.close();
		}
	});

	test("Herdr: the addendum file goes in before the body", async () => {
		const w = await createWorld({ herdr: true, appendSystem: "ADDENDUM-MARKER pi-bridge rules", userAgents: reader });
		try {
			const r = await w.tool("agent", { subagent_type: "reader", description: "r", prompt: "go", run_in_background: true });
			assert.equal(r.isError, false, r.text);
			const argv: string[] = w.herdr.calls("run")[0].argv;
			const values = argv.flatMap((a, i) => (argv[i - 1] === "--append-system-prompt" ? [a] : []));
			assert.equal(values.length, 2);
			assert.match(readFileSync(values[0], "utf8"), /ADDENDUM-MARKER/);
			assert.match(values[1], /BODY-MARKER/);
		} finally {
			await w.close();
		}
	});

	test("Herdr: no addendum file, only the body", async () => {
		const w = await createWorld({ herdr: true, userAgents: reader });
		try {
			await w.tool("agent", { subagent_type: "reader", description: "r", prompt: "go", run_in_background: true });
			const argv: string[] = w.herdr.calls("run")[0].argv;
			assert.equal(argv.filter((a) => a === "--append-system-prompt").length, 1);
		} finally {
			await w.close();
		}
	});
});
