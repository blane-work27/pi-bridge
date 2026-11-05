import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AddressInfo } from "node:net";

const HOST = process.env.CLAUDE_SUB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CLAUDE_SUB_PORT ?? "8090");
const KEY = process.env.CLAUDE_SUB_KEY ?? "";
const WORKDIR = process.env.CLAUDE_SUB_WORKDIR ?? `${process.env.HOME}/.local/state/sub-bridge/work`;
const CLAUDE_BIN = process.env.CLAUDE_SUB_CLAUDE_BIN || "claude";
const IDLE_MS = Number(process.env.CLAUDE_SUB_IDLE_MS ?? String(30 * 60 * 1000));
const MAX_BODY = 64 * 1024 * 1024;
const MODEL_RE = /^claude-[a-z0-9-]+$/;
const MODELS = (process.env.CLAUDE_SUB_MODELS ?? "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5").split(",").map((m) => m.trim()).filter(Boolean);
const MCP_NAME = "c";
const PREFIX = `mcp__${MCP_NAME}__`;
const TOOL_USE_ID_META = "claudecode/toolUseId";
const TOOL_NOTE = "The tools available in this conversation come from the client application and run on the client's machine. Use them as the client's instructions describe. The working directory in your environment section is a placeholder: use the working directory and paths that the client's instructions give, and use relative paths when the client gives no directory.";
const CLAUDE_SETTINGS = JSON.stringify({
  includeGitInstructions: false,
  claudeMdExcludes: ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"],
});

if (KEY.length < 32) {
  console.error("sub-bridge: CLAUDE_SUB_KEY must be set to a secret of 32 or more characters");
  process.exit(1);
}
mkdirSync(WORKDIR, { recursive: true });

type Block = Record<string, any>;
type ApiMessage = { role: "user" | "assistant"; content: string | Block[] };
type ClientTool = { name: string; description?: string; input_schema?: Record<string, unknown> };
type McpResult = { content: Block[]; isError?: boolean };

type Sink = {
  event: (ev: Block) => void;
  end: () => void;
  fail: (status: number, type: string, message: string) => void;
  started: boolean;
  closed: boolean;
};

type Live = {
  id: string;
  mcpToken: string;
  model: string;
  tools: ClientTool[];
  toolKey: string;
  sink: Sink | null;
  expected: Set<string>;
  turnToolUses: { id: string; name: string }[];
  pending: Map<string, (r: McpResult) => void>;
  results: Map<string, McpResult>;
  stopReason: string | null;
  child: ChildProcess | null;
  idle: NodeJS.Timeout | null;
  done: boolean;
  started: number;
};

const liveByToolUse = new Map<string, Live>();
const liveByMcpToken = new Map<string, Live>();

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

function keyMatches(given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function textOf(content: string | Block[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function stripCache(block: Block): Block {
  const { cache_control, ...rest } = block;
  return rest;
}

function blockToTranscript(block: Block): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return "[image omitted]";
    case "document":
      return "[document omitted]";
    case "tool_use":
      return `[tool call ${block.name} id=${block.id}] ${JSON.stringify(block.input ?? {})}`;
    case "tool_result": {
      const body = typeof block.content === "string"
        ? block.content
        : (block.content ?? []).map((c: Block) => (c.type === "text" ? c.text : `[${c.type} omitted]`)).join("\n");
      return `[tool result id=${block.tool_use_id}${block.is_error ? " error" : ""}]\n${body}`;
    }
    default:
      return "";
  }
}

function messageToTranscript(m: ApiMessage): string {
  const parts = typeof m.content === "string" ? [m.content] : m.content.map(blockToTranscript).filter(Boolean);
  return `<${m.role}>\n${parts.join("\n")}\n</${m.role}>`;
}

function buildPrompt(messages: ApiMessage[]): Block[] {
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1);
  const lastBlocks: Block[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const hasToolResults = lastBlocks.some((b) => b.type === "tool_result");
  if (history.length === 0 && !hasToolResults) return lastBlocks.map(stripCache);
  const out: Block[] = [];
  if (history.length) {
    out.push({
      type: "text",
      text: `Earlier turns of this conversation, for context:\n<conversation_history>\n${history.map(messageToTranscript).join("\n")}\n</conversation_history>`,
    });
  }
  for (const b of lastBlocks) {
    if (b.type === "text" || b.type === "image" || b.type === "document") out.push(stripCache(b));
    else if (b.type === "tool_result") out.push({ type: "text", text: blockToTranscript(b) });
  }
  if (hasToolResults) out.push({ type: "text", text: "Continue from the tool results above." });
  return out;
}

function toMcpResult(block: Block): McpResult {
  const content: Block[] = [];
  if (typeof block.content === "string") content.push({ type: "text", text: block.content });
  else for (const c of block.content ?? []) {
    if (c.type === "text") content.push({ type: "text", text: c.text });
    else if (c.type === "image" && c.source?.type === "base64") content.push({ type: "image", data: c.source.data, mimeType: c.source.media_type });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return { content, isError: Boolean(block.is_error) };
}

function effortOf(body: Block): string | undefined {
  const effort = body.output_config?.effort;
  return ["low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : undefined;
}

function thinkingDisabled(body: Block): boolean {
  return !body.thinking || body.thinking.type === "disabled";
}

function childEnv(body: Block): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_SUB_") || k.startsWith("CLAUDE_CODE_USE_")) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_SESSION") || k === "CLAUDE_CODE_ENTRYPOINT" || k.startsWith("CLAUDE_CODE_MESSAGING") || k === "CLAUDE_CODE_CHILD_SESSION") continue;
    env[k] = v;
  }
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
  env.DISABLE_AUTO_COMPACT = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.MCP_TOOL_TIMEOUT = String(IDLE_MS + 60_000);
  if (thinkingDisabled(body)) env.MAX_THINKING_TOKENS = "0";
  if (typeof body.max_tokens === "number" && body.max_tokens > 0) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(body.max_tokens));
  return env;
}

function sseSink(res: http.ServerResponse): Sink {
  const sink: Sink = {
    started: false,
    closed: false,
    event(ev) {
      if (sink.closed) return;
      if (!sink.started) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        sink.started = true;
      }
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    },
    end() {
      if (sink.closed) return;
      sink.closed = true;
      res.end();
    },
    fail(status, type, message) {
      if (sink.closed) return;
      sink.closed = true;
      if (!sink.started) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type, message } }));
      } else {
        res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`);
      }
    },
  };
  return sink;
}

function jsonSink(res: http.ServerResponse): Sink {
  let message: Block | null = null;
  const partialJson = new Map<number, string>();
  const sink: Sink = {
    started: false,
    closed: false,
    event(ev) {
      sink.started = true;
      if (ev.type === "message_start") {
        message = { ...ev.message, content: [] };
      } else if (!message) {
        return;
      } else if (ev.type === "content_block_start") {
        message.content[ev.index] = { ...ev.content_block };
      } else if (ev.type === "content_block_delta") {
        const b = message.content[ev.index];
        const d = ev.delta;
        if (!b) return;
        if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = d.signature;
        else if (d.type === "input_json_delta") partialJson.set(ev.index, (partialJson.get(ev.index) ?? "") + d.partial_json);
      } else if (ev.type === "content_block_stop") {
        const b = message.content[ev.index];
        const raw = partialJson.get(ev.index);
        if (b && raw !== undefined) {
          try { b.input = raw ? JSON.parse(raw) : {}; } catch { b.input = {}; }
        }
      } else if (ev.type === "message_delta") {
        Object.assign(message, ev.delta);
        message.usage = { ...(message.usage ?? {}), ...(ev.usage ?? {}) };
      }
    },
    end() {
      if (sink.closed) return;
      sink.closed = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message ?? {}));
    },
    fail(status, type, msg) {
      if (sink.closed) return;
      sink.closed = true;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type, message: msg } }));
    },
  };
  return sink;
}

function cleanup(live: Live, reason: string) {
  if (live.done) return;
  live.done = true;
  if (live.idle) clearTimeout(live.idle);
  for (const id of live.expected) liveByToolUse.delete(id);
  liveByMcpToken.delete(live.mcpToken);
  for (const resolve of live.pending.values()) resolve({ content: [{ type: "text", text: "cancelled" }], isError: true });
  live.pending.clear();
  if (live.child && live.child.exitCode === null) {
    live.child.stdin?.end();
    live.child.kill("SIGTERM");
    setTimeout(() => { if (live.child && live.child.exitCode === null) live.child.kill("SIGKILL"); }, 5000).unref();
  }
  log({ live: live.id, event: "closed", reason, seconds: Math.round((Date.now() - live.started) / 1000) });
}

function failLive(live: Live, status: number, type: string, message: string) {
  log({ live: live.id, event: "error", status, type, message });
  live.sink?.fail(status, type, message);
  live.sink = null;
  cleanup(live, type);
}

function handleStreamEvent(live: Live, ev: Block) {
  if (ev.type === "message_start") {
    live.turnToolUses = [];
    live.stopReason = null;
    ev = { ...ev, message: { ...ev.message, model: live.model } };
  } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
    const name = String(ev.content_block.name ?? "");
    const clientName = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
    live.turnToolUses.push({ id: ev.content_block.id, name: clientName });
    const { caller, ...block } = ev.content_block;
    ev = { ...ev, content_block: { ...block, name: clientName } };
  } else if (ev.type === "message_delta") {
    live.stopReason = ev.delta?.stop_reason ?? live.stopReason;
  }
  if (!live.sink) {
    if (ev.type === "message_start") log({ live: live.id, event: "unattached_turn" });
    return;
  }
  live.sink.event(ev);
  if (ev.type !== "message_stop") return;
  const sink = live.sink;
  live.sink = null;
  if (live.stopReason === "tool_use" && live.turnToolUses.length) {
    live.expected = new Set(live.turnToolUses.map((t) => t.id));
    for (const id of live.expected) liveByToolUse.set(id, live);
    live.idle = setTimeout(() => cleanup(live, "idle"), IDLE_MS);
    sink.end();
    log({ live: live.id, event: "parked", tools: live.turnToolUses.map((t) => t.name) });
  } else {
    sink.end();
    log({ live: live.id, event: "turn_end", stop_reason: live.stopReason });
    cleanup(live, "turn_end");
  }
}

function handleClaudeMessage(live: Live, msg: Block) {
  if (msg.type === "stream_event") {
    if (!msg.parent_tool_use_id) handleStreamEvent(live, msg.event);
  } else if (msg.type === "rate_limit_event") {
    const info = msg.rate_limit_info ?? {};
    log({ live: live.id, event: "rate_limit", status: info.status, type: info.rateLimitType ?? null, utilization: info.utilization ?? null, overage: Boolean(info.isUsingOverage || info.overageInUse) });
    if (info.isUsingOverage || info.overageInUse) {
      failLive(live, 429, "rate_limit_error", "Claude subscription limit reached. sub-bridge refuses requests billed to Extra Usage.");
    } else if (info.status === "rejected") {
      const resets = info.resetsAt ? ` Resets at ${new Date(info.resetsAt * 1000).toISOString()}.` : "";
      failLive(live, 429, "rate_limit_error", `Claude subscription limit reached (${info.rateLimitType ?? "unknown"}).${resets}`);
    }
  } else if (msg.type === "assistant" && msg.error) {
    const err = String(msg.error);
    const status = err === "rate_limit" ? 429 : err === "authentication_failed" ? 401 : err === "billing_error" ? 402 : 502;
    failLive(live, status, status === 429 ? "rate_limit_error" : "api_error", `Claude Code reported ${err}: ${textOf(msg.message?.content)}`);
  } else if (msg.type === "result") {
    if (msg.subtype !== "success" || msg.is_error) {
      const detail = (msg.errors ?? []).join("; ") || msg.result || msg.subtype;
      failLive(live, 502, "api_error", `Claude Code ended with ${msg.subtype}: ${detail}`);
    } else {
      cleanup(live, "result");
    }
  }
}

function startFresh(body: Block, sink: Sink, mcpPort: number) {
  const tools: ClientTool[] = Array.isArray(body.tools) ? body.tools.filter((t: Block) => typeof t.name === "string" && !/_\d{8}$/.test(String(t.type ?? ""))) : [];
  const system = typeof body.system === "string" ? body.system : textOf(body.system);
  const append = [system, tools.length ? TOOL_NOTE : ""].filter(Boolean).join("\n\n");
  const live: Live = {
    id: randomUUID().slice(0, 8),
    mcpToken: randomBytes(24).toString("hex"),
    model: body.model,
    tools,
    toolKey: tools.map((t) => t.name).sort().join(","),
    sink,
    expected: new Set(),
    turnToolUses: [],
    pending: new Map(),
    results: new Map(),
    stopReason: null,
    child: null,
    idle: null,
    done: false,
    started: Date.now(),
  };
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", body.model,
    "--tools", "",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--setting-sources", "",
    "--settings", CLAUDE_SETTINGS,
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  if (append) args.push("--append-system-prompt", append);
  const effort = effortOf(body);
  if (effort && !thinkingDisabled(body)) args.push("--effort", effort);
  if (tools.length) {
    liveByMcpToken.set(live.mcpToken, live);
    const mcpConfig = { mcpServers: { [MCP_NAME]: { type: "http", url: `http://127.0.0.1:${mcpPort}/mcp/${live.mcpToken}` } } };
    args.push("--mcp-config", JSON.stringify(mcpConfig), "--allowedTools", `mcp__${MCP_NAME}`);
  }
  const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env: childEnv(body), stdio: ["pipe", "pipe", "pipe"] });
  live.child = child;
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => { stderr = (stderr + c.toString()).slice(-4000); });
  child.on("error", (e) => failLive(live, 502, "api_error", `cannot start Claude Code: ${e.message}`));
  child.on("exit", (code, signal) => {
    if (!live.done) {
      live.sink?.fail(502, "api_error", `Claude Code exited (code ${code}, signal ${signal}) before the turn finished. ${stderr.trim().slice(-600)}`);
      live.sink = null;
      cleanup(live, "exit");
    }
  });
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (!line.trim() || live.done) return;
    let msg: Block;
    try { msg = JSON.parse(line); } catch { return; }
    handleClaudeMessage(live, msg);
  });
  const first = { type: "user", message: { role: "user", content: buildPrompt(body.messages) }, parent_tool_use_id: null, session_id: "" };
  child.stdin!.write(JSON.stringify(first) + "\n");
  log({ live: live.id, event: "fresh", model: body.model, messages: body.messages.length, tools: tools.length, effort: effort ?? null, thinking: !thinkingDisabled(body) });
  return live;
}

function tryContinue(body: Block, sink: Sink): Live | null {
  const last = body.messages[body.messages.length - 1];
  if (last?.role !== "user" || !Array.isArray(last.content)) return null;
  const results = last.content.filter((b: Block) => b.type === "tool_result");
  if (!results.length) return null;
  const live = liveByToolUse.get(results[0].tool_use_id);
  if (!live || live.done) return null;
  const ids = new Set<string>(results.map((r: Block) => r.tool_use_id));
  const extraText = last.content.some((b: Block) => b.type === "text" && String(b.text ?? "").trim());
  const tools: ClientTool[] = Array.isArray(body.tools) ? body.tools : [];
  const toolKey = tools.filter((t) => !/_\d{8}$/.test(String((t as Block).type ?? ""))).map((t) => t.name).sort().join(",");
  const matches = body.model === live.model && toolKey === live.toolKey && !extraText && ids.size === live.expected.size && [...ids].every((id) => live.expected.has(id));
  if (!matches) {
    cleanup(live, "history_diverged");
    return null;
  }
  if (live.idle) clearTimeout(live.idle);
  live.idle = null;
  for (const id of live.expected) liveByToolUse.delete(id);
  live.expected = new Set();
  live.sink = sink;
  for (const r of results) {
    const mcp = toMcpResult(r);
    const resolve = live.pending.get(r.tool_use_id);
    if (resolve) {
      live.pending.delete(r.tool_use_id);
      resolve(mcp);
    } else {
      live.results.set(r.tool_use_id, mcp);
    }
  }
  log({ live: live.id, event: "continue", results: results.length });
  return live;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function apiError(res: http.ServerResponse, status: number, type: string, message: string) {
  sendJson(res, status, { type: "error", error: { type, message } });
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function mcpToolCall(live: Live, params: Block): Promise<McpResult> {
  let id: string | undefined = params._meta?.[TOOL_USE_ID_META];
  if (!id) {
    id = live.turnToolUses.find((t) => t.name === params.name && !live.pending.has(t.id) && !live.results.has(t.id))?.id;
  }
  if (!id) return Promise.resolve({ content: [{ type: "text", text: "sub-bridge could not match this tool call to a tool_use id" }], isError: true });
  const ready = live.results.get(id);
  if (ready) {
    live.results.delete(id);
    return Promise.resolve(ready);
  }
  return new Promise((resolve) => live.pending.set(id!, resolve));
}

const mcpServer = http.createServer(async (req, res) => {
  const match = /^\/mcp\/([0-9a-f]{48})$/.exec(new URL(req.url ?? "/", "http://x").pathname);
  const live = match ? liveByMcpToken.get(match[1]) : undefined;
  if (!live || live.done) return sendJson(res, 404, rpcError(null, -32001, "unknown MCP session"));
  if (req.method === "GET") {
    res.writeHead(405, { allow: "POST" });
    return res.end();
  }
  if (req.method === "DELETE") {
    res.writeHead(200);
    return res.end();
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    return res.end();
  }
  let msg: Block;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, rpcError(null, -32700, "parse error"));
  }
  if (Array.isArray(msg)) return sendJson(res, 400, rpcError(null, -32600, "batches are not supported"));
  if (msg.id === undefined || msg.id === null) {
    res.writeHead(202);
    return res.end();
  }
  switch (msg.method) {
    case "initialize":
      return sendJson(res, 200, rpcResult(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sub-bridge", version: "1.0.0" },
      }));
    case "ping":
      return sendJson(res, 200, rpcResult(msg.id, {}));
    case "tools/list":
      return sendJson(res, 200, rpcResult(msg.id, {
        tools: live.tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.input_schema && (t.input_schema as Block).type === "object" ? t.input_schema : { type: "object", properties: {} },
        })),
      }));
    case "tools/call": {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 30_000);
      const result = await mcpToolCall(live, msg.params ?? {});
      clearInterval(keepalive);
      res.end(`event: message\ndata: ${JSON.stringify(rpcResult(msg.id, result))}\n\n`);
      return;
    }
    default:
      return sendJson(res, 200, rpcError(msg.id, -32601, `method ${msg.method} is not supported`));
  }
});

mcpServer.listen(0, "127.0.0.1", () => {
  const mcpPort = (mcpServer.address() as AddressInfo).port;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { status: "ok", parked: liveByToolUse.size });
    if (!keyMatches(req.headers["x-sub-bridge-key"] as string | undefined)) return apiError(res, 401, "authentication_error", "missing or wrong x-sub-bridge-key");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, { data: MODELS.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" })), has_more: false, first_id: MODELS[0] ?? null, last_id: MODELS[MODELS.length - 1] ?? null });
    }
    if (req.method !== "POST" || url.pathname !== "/v1/messages") return apiError(res, 404, "not_found_error", `${req.method} ${url.pathname} is not supported`);

    let body: Block;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return apiError(res, 400, "invalid_request_error", `cannot read the request body: ${(e as Error).message}`);
    }
    if (typeof body.model !== "string" || !MODEL_RE.test(body.model)) return apiError(res, 400, "invalid_request_error", `model must be a Claude model id, got ${JSON.stringify(body.model)}`);
    if (!Array.isArray(body.messages) || body.messages.length === 0) return apiError(res, 400, "invalid_request_error", "messages must be a non-empty array");
    if (body.messages[body.messages.length - 1].role !== "user") return apiError(res, 400, "invalid_request_error", "the last message must have role user");

    const sink = body.stream ? sseSink(res) : jsonSink(res);
    const live = tryContinue(body, sink) ?? startFresh(body, sink, mcpPort);
    res.on("close", () => {
      if (!sink.closed && live.sink === sink) {
        live.sink = null;
        cleanup(live, "client_disconnected");
      }
    });
  });
  server.listen(PORT, HOST, () => log({ event: "listening", host: HOST, port: PORT, mcp_port: mcpPort, claude: CLAUDE_BIN, models: MODELS }));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      for (const live of new Set([...liveByToolUse.values(), ...liveByMcpToken.values()])) cleanup(live, "shutdown");
      server.close();
      mcpServer.close();
      setTimeout(() => process.exit(0), 1000).unref();
    });
  }
});
