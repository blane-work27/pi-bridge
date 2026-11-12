// The `fetch` tool: reads a web page as text. Registered only in a subagent whose definition lists
// `WebFetch`, never in the orchestrator. The page download and the HTML-to-text conversion are jank's (../jank/fetch.ts).
//
// TLS: this is Node's global fetch with its default trust store and verification on. Nothing here
// touches the CA store. PI_OFFLINE (which pi-bridge sets) only gates pi's own network use (model
// refresh, package installs), not a tool's fetch calls.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fetchPage } from "../jank/fetch.ts";

/** Characters returned per call; a longer page continues from the `offset` the footer names. */
export const PAGE_CHARS = 20000;

/** Keep the lines that match `pattern` (a case-insensitive regular expression). */
export function filterLines(text: string, pattern: string): string {
	let re: RegExp;
	try {
		re = new RegExp(pattern, "i");
	} catch (e) {
		throw new Error(`Invalid pattern: ${(e as Error).message}`);
	}
	return text.split("\n").filter((l) => re.test(l)).join("\n");
}

/** The text of one call: filtered, then cut to the window starting at `offset`. */
export function window(text: string, offset: number, limit = PAGE_CHARS): string {
	if (offset >= text.length && text.length > 0) throw new Error(`offset ${offset} is past the end of the text (${text.length} characters)`);
	const end = offset + limit;
	const slice = text.slice(offset, end);
	return end < text.length ? `${slice}\n\n[truncated: ${text.length - end} more characters. Call again with offset ${end}.]` : slice;
}

export const fetchTool = defineTool({
	name: "fetch",
	label: "fetch",
	description:
		"Fetch a web page over http(s) and return it as text (HTML is converted). Use `pattern` to keep only the lines matching a regular expression, and `offset` to read on when the result says it was truncated.",
	parameters: Type.Object({
		url: Type.String({ description: "The http or https URL." }),
		pattern: Type.Optional(Type.String({ description: "Case-insensitive regular expression: return only the matching lines." })),
		offset: Type.Optional(Type.Number({ description: "Character offset to start from, to continue a truncated result. Default 0." })),
	}),
	executionMode: "parallel",
	async execute(_id, params, signal) {
		const page = await fetchPage(params.url, signal);
		if (page.status >= 400) throw new Error(`HTTP ${page.status} for ${page.url}`);
		const text = params.pattern ? filterLines(page.text, params.pattern) : page.text;
		if (params.pattern && !text) return { content: [{ type: "text", text: `No lines match ${params.pattern} in ${page.url}` }], details: undefined };
		return { content: [{ type: "text", text: window(text, Math.max(0, Math.floor(params.offset ?? 0))) }], details: undefined };
	},
});

/** The inline extension a subagent gets when its definition lists WebFetch. */
export const createFetchExtension = (): ExtensionFactory => (pi) => {
	pi.registerTool(fetchTool);
};
