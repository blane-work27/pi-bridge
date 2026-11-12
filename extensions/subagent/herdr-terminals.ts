// The Herdr terminal interface: the only code in the extension that runs `hc`.
// The Herdr backend (herdr-backend.ts) talks to this interface, and tests give it a fake `hc`
// binary through `HcTerminals`' `bin` option.
import { spawn } from "node:child_process";

/** What `hc wait` and `hc get` report about a terminal. */
export interface TerminalState {
	/** Herdr's status: `working`, `idle`, `done`, `blocked`, `error`, ... */
	status: string;
	/** Counts turns; pi reports `idle` at turn 0 on startup, before it starts its first message. */
	turn: number;
	/** The terminal's program has exited. */
	ended: boolean;
	reason?: string;
}

export interface RunOptions {
	name: string;
	/** The orchestrator's terminal. */
	parent: string;
	cwd: string;
	/** Program and arguments. */
	argv: string[];
}

export interface HerdrTerminals {
	/** Start a background terminal, a child of `parent` that ends with it and types no notes into it. */
	run(o: RunOptions): Promise<{ address: string }>;
	/** Block until the terminal's status changes (or Herdr checks in after its timeout). Rejects when `signal` aborts. */
	wait(target: string, signal?: AbortSignal): Promise<TerminalState>;
	/** Type text into the terminal and press Enter. */
	send(target: string, text: string): Promise<void>;
	/** End the terminal's program and its process tree. */
	kill(target: string): Promise<void>;
	get(target: string): Promise<TerminalState>;
}

export interface HcResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export type HcRunner = (bin: string, args: string[], signal?: AbortSignal) => Promise<HcResult>;

export const spawnRunner: HcRunner = (bin, args, signal) =>
	new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});

function parseState(raw: any): TerminalState {
	const status = raw?.status;
	return {
		status: typeof status === "string" ? status : (status?.state ?? "unknown"),
		turn: typeof raw?.turn === "number" ? raw.turn : 0,
		// `ended` only says the wait ended (reason `status` for a status change, `timeout`, `message`, ...).
		// The terminal itself has ended on reason exit/killed, an exit code or signal, or state finished.
		ended: raw?.reason === "exit" || raw?.reason === "killed" || (raw?.exit_code ?? null) !== null || (raw?.signal ?? null) !== null || raw?.state === "finished",
		...(typeof raw?.reason === "string" ? { reason: raw.reason } : {}),
	};
}

export class HcTerminals implements HerdrTerminals {
	private readonly bin: string;
	private readonly runner: HcRunner;

	constructor(opts: { bin?: string; runner?: HcRunner } = {}) {
		this.bin = opts.bin ?? "hc";
		this.runner = opts.runner ?? spawnRunner;
	}

	private async hc(args: string[], signal?: AbortSignal): Promise<any> {
		// `--json` goes right after the subcommand: after a `--` it would reach the child program.
		const r = await this.runner(this.bin, [args[0], "--json", ...args.slice(1)], signal);
		let json: any;
		try {
			json = r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
		} catch {
			json = undefined;
		}
		if (r.code !== 0) {
			const message = json?.error?.message ?? (r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`);
			throw new Error(`hc ${args[0]} failed: ${message}`);
		}
		return json;
	}

	async run(o: RunOptions): Promise<{ address: string }> {
		// No --outlive-parent: the child ends when the orchestrator does.
		const json = await this.hc(["run", "--bg", "--name", o.name, "--parent", o.parent, "--no-notify", "--cwd", o.cwd, "--", ...o.argv]);
		return { address: typeof json?.address === "string" ? json.address : o.name };
	}

	async wait(target: string, signal?: AbortSignal): Promise<TerminalState> {
		return parseState(await this.hc(["wait", target], signal));
	}

	async send(target: string, text: string): Promise<void> {
		await this.hc(["send", target, text]);
	}

	async kill(target: string): Promise<void> {
		await this.hc(["kill", target]);
	}

	async get(target: string): Promise<TerminalState> {
		return parseState(await this.hc(["get", target]));
	}
}
