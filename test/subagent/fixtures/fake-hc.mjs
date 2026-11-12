// A fake `hc` for the Herdr backend tests. It runs no program: `hc run` only records the call and
// creates a terminal in state `idle`, turn 0 (pi's startup idle). The test moves the terminal along
// by rewriting `term-<name>.json` in $FAKE_HC_DIR (see `w.herdr` in harness.ts).
//   run   --bg --name N --parent P --no-notify --cwd D -- argv...   records, prints {"address":"tN"}
//   wait  T --json    returns the state at once the first time, then blocks until it changes
//   send  T TEXT      records
//   kill  T           records, ends the terminal
//   get   T           prints the state
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_HC_DIR;
// Like the real hc, everything after `--` belongs to the program: `--json` there is not ours.
const raw = process.argv.slice(2);
const dashes = raw.indexOf("--");
const args = [...raw.slice(0, dashes < 0 ? raw.length : dashes).filter((a) => a !== "--json"), ...(dashes < 0 ? [] : raw.slice(dashes))];
const [cmd, ...rest] = args;
const log = (entry) => appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(entry)}\n`);
const fail = (message) => {
	process.stdout.write(JSON.stringify({ error: { kind: "not_found", message } }));
	process.exit(3);
};
const file = (name) => join(dir, `term-${name}.json`);
const read = (name) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : fail(`no terminal "${name}"`));
// The real shape: `ended` says the WAIT ended, whatever the reason. Only reason exit/killed (or an exit code) means the terminal itself ended.
const out = (name, s) =>
	process.stdout.write(
		JSON.stringify(
			s.ended
				? { children: [], ended: true, exit_code: s.exit_code ?? 0, reason: s.reason ?? "exit", signal: null, status: null, terminal: name, turn: s.turn }
				: { children: [], ended: true, exit_code: null, reason: "status", signal: null, status: s.status, terminal: name, turn: s.turn },
		),
	);

if (cmd === "run") {
	if (existsSync(join(dir, "fail-run"))) fail("the core is not reachable");
	const sep = rest.indexOf("--");
	const flags = rest.slice(0, sep);
	const opt = (n) => flags[flags.indexOf(n) + 1];
	const name = opt("--name");
	log({ cmd, flags, name, parent: opt("--parent"), cwd: opt("--cwd"), argv: rest.slice(sep + 1) });
	writeFileSync(file(name), JSON.stringify({ status: "idle", turn: 0 }));
	process.stdout.write(JSON.stringify({ address: `t-${name}` }));
} else if (cmd === "wait") {
	const name = rest[0];
	const seenFile = join(dir, `seen-${name}`);
	const key = (s) => JSON.stringify(s);
	for (;;) {
		const s = read(name);
		if (!existsSync(seenFile) || readFileSync(seenFile, "utf8") !== key(s)) {
			writeFileSync(seenFile, key(s));
			out(name, s);
			break;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
} else if (cmd === "send") {
	read(rest[0]);
	log({ cmd, target: rest[0], text: rest[1], flags: rest.slice(2) });
	process.stdout.write("{}");
} else if (cmd === "kill") {
	const s = read(rest[0]);
	log({ cmd, target: rest[0] });
	writeFileSync(file(rest[0]), JSON.stringify({ ...s, status: "exited", ended: true, reason: "killed" }));
	process.stdout.write("{}");
} else if (cmd === "get") {
	out(rest[0], read(rest[0]));
} else {
	fail(`fake hc: unsupported command ${cmd}`);
}
