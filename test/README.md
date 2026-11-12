# Tests

Run all tests with one command from the repo root (Node 22, from `~/.local/node/bin`):

```bash
node --import ./test/register.mjs --test 'test/**/*.test.ts'
```

- No `npm install` is needed. `test/register.mjs` resolves `@earendil-works/*` from `~/.local/share/pi-icr/node_modules`. Set `PI_SDK_DIR` to use another install.
- Node strips the TypeScript types itself.
- Tests drive an extension through a real pi SDK session on the faux model provider, against throwaway git repos in a temp dir.
- `test/git-guard/harness.ts` is the reusable part: `callTool({ cwd, tool, args, ui, approve })` has the model call one tool and returns the result plus every dialog the UI recorded.
- git-guard reads `SUBAGENT_STATE_DIR` (default `~/.local/state/subagent`) for the subagent worktree directory. The harness points it at a temp dir, so tests never touch the real one.

## Subagent tests

The tests of `extensions/subagent/` are in `test/subagent/`. Run only these with:

```bash
PATH=~/.local/node/bin:$PATH node --import ./test/register.mjs --test 'test/subagent/*.test.ts'
```

The suite takes a few seconds and needs no network or secrets. Each test builds its own temp agentDir. Node strips the TypeScript types itself, so use `import type`, `.ts` relative imports, and no enums.

### The harness (`test/subagent/harness.ts`)

`createWorld(opts)` returns an orchestrator: a real pi SDK session with the extension listed in a temp agentDir's `settings.json`. Parent and children run on pi's faux provider through the agentDir's `models.json` (provider `bifrost`, a faux api), so the extension runs unmodified.

- `w.run(calls)` has the parent call `agent` once per entry in one message and resolves to `{ results }` (`isError`, `text`, `details` per call). `w.start(calls)` returns `{ done, results() }` without waiting, for dialogs and abort.
- `w.tool(name, args)` runs one parent turn calling any tool (`agent_send`, `agent_status`, ...). `w.startTools([{ name, args }])` is the multi-call form. `agent` calls may set `run_in_background`. `w.parentNotices` lists the texts of parent turns that something other than the test started, for example a background subagent's finish notice. Use `GATE <path>` (release by writing `<path>.go`) or `HOLD <file>` to keep a background subagent running.
- `run.updates(i)` (from `w.start` or `w.run`) is the progress `details` of call `i`, one per `onUpdate`.
- `createWorld({ persist: true })` gives the orchestrator a session file. The default is in-memory. `w.stateDir` is where transcripts go without a session file (the world sets `XDG_STATE_HOME`). A prompt sent to a resumed transcript makes the child report `continued: <msg> | first: <first prompt> | messages: N`.
- `createWorld({ userAgents, projectAgents, trustedProject })` writes agent definition files (name to Markdown) to a temp user agents folder and to the project's `.claude/agents/`, and sets project trust. The extension is loaded through a generated wrapper that calls `createSubagentExtension({ userDir })`. `w.userAgentsDir` is the temp folder, for editing a definition between calls.
- `createWorld({ herdr: true })` sets `HC_TERMINAL_ID=t1` and points the extension at a fake `hc` script (`fixtures/fake-hc.mjs`). Without it the world clears `HC_TERMINAL_ID`, `HC_SCOPE`, and `PI_SUBAGENT`, so background calls run in-process even when the tests run in a Herdr terminal. `w.herdr.calls(cmd?)` lists the recorded `hc` calls. `w.herdr.set(id, {status, turn})` moves a terminal (it starts `idle` at turn 0). `w.herdr.finish(id, text, turn)` writes the child's answer to its session file and reports `done`. `w.herdr.failRuns()` makes `hc run` fail.
- `createWorld({ git: true })` makes the project a git repository with one commit, for `isolation: "worktree"`. The harness points `SUBAGENT_STATE_DIR` at a temp dir.
- `w.abort()` aborts the parent's turn, which fires the signal of every running `agent` call.
- `w.dialogs` records every dialog the UI got (`title`, `resolve(value)` settles it). Pass `answer` to `createWorld` to answer automatically.
- `w.mcp.started()` and `w.mcp.running()` list the pids of the stdio MCP fixture (`fixtures/mcp-server.mjs`, enabled with `{ mcp: true }`).
- `createWorld({ askTools: [names] })` also loads `fixtures/ask-tools-extension.ts`. Before a call to one of those tools it raises a confirm dialog, and it blocks the call when the answer is no. Prompt `PING` has the child call the fixture's MCP tool through codemode.
- `w.parentToolNames` lists the tools the parent's model was offered, per request.
- Prompts steer the scripted model: `OK <text>`, `TOOLS`, `PROMPT`, `ASK <tag>`, `FAIL <msg>`, `SLOWFAIL <msg>`, `BASH <cmd>`, `FETCH <json>`, `HOLD <file>`. The list is at the top of `harness.ts`. To add a behaviour, add a verb to the `route` function there.
- `fixtures/probe.ts` is a test extension that parent and child both load. It has `probe_ask` (raises a dialog) and `jank_fake` (an active tool named like a jank tool).
- Do not run `pgrep -f` for a command line that your own shell command also contains. Match with an anchored pattern such as `^sleep 300$`.
