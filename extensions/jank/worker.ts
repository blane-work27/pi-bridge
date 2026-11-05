import { readFileSync } from "node:fs";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { fetchPage } from "./fetch.ts";

export default function (pi: ExtensionAPI) {
	const schemaFile = process.env.JANK_SCHEMA_FILE;
	if (schemaFile) {
		const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
		pi.registerTool(
			defineTool({
				name: "submit",
				label: "Submit",
				description:
					"Submit your final answer. The arguments must match the required schema. Call this exactly once, as your last action.",
				promptSnippet: "Submit the final answer as structured data",
				promptGuidelines: [
					"Finish by calling submit with your final answer. Do not answer in plain text.",
					"If submit reports a validation error, fix the arguments and call submit again.",
				],
				parameters: schema,
				async execute(_id, params) {
					return {
						content: [{ type: "text", text: "Submitted." }],
						details: params,
						terminate: true,
					};
				},
			}),
		);
	}

	if (process.env.JANK_FETCH === "1") {
		pi.registerTool(
			defineTool({
				name: "jank_fetch",
				label: "Fetch",
				description:
					"Fetch a web page over http or https and return its text. HTML is converted to plain text. Use pattern to get only the parts that match, which is best for large files. Use offset to read past the first max_chars characters.",
				promptSnippet: "Fetch a URL and read its text",
				parameters: Type.Object({
					url: Type.String({ description: "The http or https URL" }),
					pattern: Type.Optional(Type.String({ description: "Case-insensitive text or regular expression. Returns each match with 15 lines of context around it." })),
					offset: Type.Optional(Type.Number({ description: "Character offset to start from. Default 0." })),
					max_chars: Type.Optional(Type.Number({ description: "Characters to return. Default 20000, maximum 60000." })),
				}),
				async execute(_id, params, signal) {
					const page = await fetchPage(params.url, signal);
					if (params.pattern) {
						let re: RegExp;
						try {
							re = new RegExp(params.pattern, "i");
						} catch {
							re = new RegExp(params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
						}
						const lines = page.text.split("\n");
						const hits: string[] = [];
						let last = -1;
						for (let i = 0; i < lines.length && hits.length < 20; i++) {
							if (!re.test(lines[i]) || i <= last) continue;
							const from = Math.max(0, i - 15, last + 1);
							const to = Math.min(lines.length, i + 16);
							hits.push(`--- lines ${from + 1}-${to} ---\n${lines.slice(from, to).join("\n")}`);
							last = to - 1;
						}
						const head = `URL: ${page.url}\nStatus: ${page.status}\nMatches for ${params.pattern}: ${hits.length ? hits.length : "none"}${hits.length === 20 ? " (first 20)" : ""}\n\n`;
						return { content: [{ type: "text", text: head + hits.join("\n\n").slice(0, 60000) }], details: undefined };
					}
					const offset = Math.max(0, Math.floor(params.offset ?? 0));
					const max = Math.min(60000, Math.max(1000, Math.floor(params.max_chars ?? 20000)));
					const slice = page.text.slice(offset, offset + max);
					const more = offset + max < page.text.length;
					const header = `URL: ${page.url}\nStatus: ${page.status}\nContent-Type: ${page.contentType}\nCharacters: ${offset}-${offset + slice.length} of ${page.text.length}${more ? ` (call again with offset ${offset + max} for more)` : ""}\n\n`;
					return { content: [{ type: "text", text: header + slice }], details: undefined };
				},
			}),
		);
	}
}
