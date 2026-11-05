const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30000;

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	copy: "©",
	reg: "®",
	trade: "™",
	laquo: "«",
	raquo: "»",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
		}
		return ENTITIES[code.toLowerCase()] ?? match;
	});
}

export function htmlToText(html: string): string {
	let s = html;
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, "");
	s = s.replace(/<(nav|footer)\b[\s\S]*?<\/\1\s*>/gi, "");
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, body: string) => `\n\`\`\`\n${body.replace(/<[^>]+>/g, "")}\n\`\`\`\n`);
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, body: string) => `\`${body.replace(/<[^>]+>/g, "")}\``);
	s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, body: string) => {
		const label = body.replace(/<[^>]+>/g, "").trim();
		return label && !href.startsWith("#") && !href.startsWith("javascript:") ? `${label} (${href})` : label;
	});
	s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `);
	s = s.replace(/<\/h[1-6]\s*>/gi, "\n\n");
	s = s.replace(/<li\b[^>]*>/gi, "\n- ");
	s = s.replace(/<(br|hr)\b[^>]*>/gi, "\n");
	s = s.replace(/<\/(p|div|section|article|header|tr|table|ul|ol|blockquote|dd|dt)\s*>/gi, "\n\n");
	s = s.replace(/<(td|th)\b[^>]*>/gi, " | ");
	s = s.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	s = s.replace(/[ \t\f\v\r]+/g, " ");
	s = s.replace(/ *\n */g, "\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
}

export async function fetchPage(url: string, signal?: AbortSignal): Promise<{ url: string; status: number; contentType: string; text: string }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Not a valid URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Only http and https URLs are allowed: ${url}`);
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const res = await fetch(parsed, {
		redirect: "follow",
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		headers: {
			"user-agent": "jank-fetch/1.0",
			accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
		},
	});
	const contentType = res.headers.get("content-type") ?? "";
	if (/^(image|audio|video|font)\//i.test(contentType) || /application\/(pdf|zip|octet-stream)/i.test(contentType)) {
		await res.body?.cancel();
		throw new Error(`The response is ${contentType}, which jank_fetch does not read.`);
	}
	const reader = res.body?.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BYTES) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
	}
	const body = new TextDecoder().decode(Buffer.concat(chunks));
	const text = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : body;
	return { url: res.url || parsed.href, status: res.status, contentType, text };
}
