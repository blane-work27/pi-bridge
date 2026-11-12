import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fetchPage } from "../../extensions/jank/fetch.ts";
import { createWorld, type World } from "./harness.ts";

const LINES = Array.from({ length: 3000 }, (_, i) => `line ${i} ${i % 500 === 0 ? "NEEDLE" : "hay"}`).join("\n");
const md = (fm: Record<string, string>, body = "") => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}\n`;
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

let http: Server;
let base: string;
before(async () => {
	http = createHttp((req, res) => {
		if (req.url === "/page") res.writeHead(200, { "content-type": "text/html" }).end("<html><nav>menu</nav><h1>Title</h1><p>Hello &amp; welcome</p><script>x()</script></html>");
		else if (req.url === "/big") res.writeHead(200, { "content-type": "text/plain" }).end(LINES);
		else res.writeHead(404, { "content-type": "text/plain" }).end("nope");
	});
	base = `http://127.0.0.1:${await listen(http)}`;
});
after(() => http.close());

describe("fetchPage", () => {
	test("returns page text with markup removed", async () => {
		const page = await fetchPage(`${base}/page`);
		assert.equal(page.status, 200);
		assert.match(page.text, /# Title/);
		assert.match(page.text, /Hello & welcome/);
		assert.doesNotMatch(page.text, /menu|x\(\)|<p>/);
	});

	test("TLS verification stays on: a self-signed HTTPS server is rejected", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fetch-tls-"));
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
		const https = createHttps({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (_q, res) => res.end("secret"));
		const port = await listen(https);
		try {
			await assert.rejects(fetchPage(`https://127.0.0.1:${port}/`), (e: any) => /fetch failed/.test(e.message) && /SELF.SIGNED|self.signed|UNABLE_TO_VERIFY/i.test(String(e.cause?.code ?? e.cause?.message)));
		} finally {
			https.close();
		}
	});
});

describe("the fetch tool in a subagent", () => {
	let w: World;
	before(async () => {
		w = await createWorld({
			userAgents: {
				"reader.md": md({ name: "reader", description: "Reads the web", tools: "Read, WebFetch" }),
				"plain.md": md({ name: "plain", description: "No web", tools: "Read" }),
			},
		});
	});
	after(() => w.close());

	const call = (subagent_type: string, args: object) => w.run([{ description: "fetch", prompt: `FETCH ${JSON.stringify(args)}`, subagent_type }]).then((r) => r.results[0]);

	test("a definition with WebFetch gives its child the fetch tool; one without does not; the orchestrator never has it", async () => {
		const { results } = await w.run([
			{ description: "a", prompt: "TOOLS", subagent_type: "reader" },
			{ description: "b", prompt: "TOOLS", subagent_type: "plain" },
			{ description: "c", prompt: "TOOLS", subagent_type: "general-purpose" },
		]);
		assert.deepEqual(JSON.parse(results[0].text).filter((t: string) => t === "fetch" || t === "read").sort(), ["fetch", "read"]);
		assert.ok(!JSON.parse(results[1].text).includes("fetch"));
		assert.ok(!JSON.parse(results[2].text).includes("fetch"));
		for (const names of w.parentToolNames) assert.ok(!names.includes("fetch"));
	});

	test("WebFetch is not reported as dropped", async () => {
		const { results } = await w.run([{ description: "p", prompt: "PROMPT", subagent_type: "reader" }]);
		assert.doesNotMatch(results[0].text, /not available in this environment/);
	});

	test("returns the page text", async () => {
		const r = await call("reader", { url: `${base}/page` });
		assert.equal(r.isError, false);
		assert.match(r.text, /Hello & welcome/);
	});

	test("pattern keeps only matching lines; a miss says so", async () => {
		const r = await call("reader", { url: `${base}/big`, pattern: "needle" });
		assert.equal(r.text, ["line 0 NEEDLE", "line 500 NEEDLE", "line 1000 NEEDLE", "line 1500 NEEDLE", "line 2000 NEEDLE", "line 2500 NEEDLE"].join("\n"));
		const none = await call("reader", { url: `${base}/big`, pattern: "zzz" });
		assert.match(none.text, /No lines match zzz/);
	});

	test("a long page is cut, and offset continues it", async () => {
		const first = await call("reader", { url: `${base}/big` });
		const m = first.text.match(/Call again with offset (\d+)\.\]$/);
		assert.ok(m, first.text.slice(-120));
		assert.equal(first.text.indexOf("\n\n[truncated"), Number(m![1]));
		const second = await call("reader", { url: `${base}/big`, offset: Number(m![1]) });
		assert.equal(first.text.slice(0, Number(m![1])), LINES.slice(0, Number(m![1])));
		assert.ok(second.text.startsWith(LINES.slice(Number(m![1]), Number(m![1]) + 30)));
	});

	test("errors are tool errors: 404, refused connection, bad URL, bad pattern, offset past the end", async () => {
		const closed = createHttp();
		const port = await listen(closed);
		await new Promise((r) => closed.close(r));
		const cases: [object, RegExp][] = [
			[{ url: `${base}/missing` }, /HTTP 404/],
			[{ url: `http://127.0.0.1:${port}/` }, /fetch failed/],
			[{ url: "ftp://example.com/" }, /Only http and https/],
			[{ url: `${base}/page`, pattern: "(" }, /Invalid pattern/],
			[{ url: `${base}/page`, offset: 99999 }, /past the end/],
		];
		for (const [args, re] of cases) {
			const r = await call("reader", args);
			assert.match(r.text, re, JSON.stringify(args));
		}
	});
});
