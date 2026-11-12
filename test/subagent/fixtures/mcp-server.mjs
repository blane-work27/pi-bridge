// A tiny stdio MCP server for the teardown tests. It records its pid in $FIXTURE_PIDFILE when it
// starts and, like a real server, exits only when its stdin closes. A server that outlives its
// session is therefore a server nobody closed.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

appendFileSync(process.env.FIXTURE_PIDFILE, `${process.pid}\n`);

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.id === undefined) return; // notification
	switch (msg.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id: msg.id,
				result: { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
			});
			break;
		case "tools/list":
			send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] } });
			break;
		case "tools/call":
			send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong" }] } });
			break;
		default:
			send({ jsonrpc: "2.0", id: msg.id, result: {} });
	}
});
rl.on("close", () => process.exit(0));
