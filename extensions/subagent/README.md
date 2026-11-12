# Subagent extension

This extension gives pi an `agent` tool that works like Claude Code's Agent tool. The orchestrator hands a task to a subagent. The subagent works in a fresh context and returns its final message as the tool result.

pi loads the extension by itself, because it is a folder in `extensions/`. It needs no setting.

## Tools

| Tool | What it does |
|---|---|
| `agent` | Starts a subagent. The parameters are `description`, `prompt`, `subagent_type`, and the optional `model`, `thinking`, `isolation`, and `run_in_background`. |
| `agent_send` | Sends a message to a background subagent. A running subagent is steered: it sees the message after its current tool calls. A finished subagent continues from its transcript, with its earlier turns. |
| `agent_stop` | Aborts a background subagent and tears it down, so nothing of it keeps running. |
| `agent_status` | Shows one background subagent, or all of them: the state, the turn, and the last activity. The states are `queued`, `running`, `idle`, `stopped`, and `failed`. |

- The subagent sees none of the orchestrator's conversation. The prompt must say everything the subagent needs.
- To run subagents in parallel, make several `agent` calls in one message.
- A subagent cannot start subagents. It does not get the `agent` tools or any `jank_*` tool.
- Without `run_in_background`, the call waits and shows live progress (tool calls and tokens). The result is the final message.
- With `run_in_background: true`, the call returns at once with the subagent's id. When the subagent finishes, the orchestrator gets a notice with its final message, and the notice starts a turn.
- Background subagents survive `/new`, `/resume`, `/fork`, and a reload. Only quitting pi stops them.

## Agent definitions

The `subagent_type` is the name of an agent definition. The definitions come from these places. A later place replaces an earlier definition with the same name:

1. The built-in agents:
   - `general-purpose` inherits the orchestrator's model and tools.
   - `Explore` is a read-only search agent. It uses the `haiku` model and the tools `read`, `grep`, `find`, `ls`, and `bash`.
2. `~/.claude/agents/*.md`. These are Claude Code's own agent files, so one definition works in both tools.
3. `.claude/agents/*.md` in the project. pi reads this folder only in a trusted project.

The extension reads the files again on each call, so an edit applies at once. A file that cannot be read is skipped.

A definition is a Markdown file. The body is added to the subagent's system prompt, after the pi-bridge addendum. The frontmatter keys are:

| Key | Meaning |
|---|---|
| `name` | The agent name. The default is the file name without `.md`. |
| `description` | What the agent is for. The orchestrator reads it in the `agent` tool description. |
| `model` | The model. See [Models](#models). The default is `inherit`. |
| `thinking` | The thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `inherit`. The default is the orchestrator's level. pi uses the nearest level the model supports. |
| `tools` | The tools, as a comma-separated string or a list. If you leave it out, or write `*`, the subagent inherits the orchestrator's tools. |

### Tools

Write the tool names as in Claude Code. The extension maps them to pi's tools:

| Claude Code | pi |
|---|---|
| `Read` | `read` |
| `Grep` | `grep` |
| `Glob` | `find` |
| `LS` | `ls` |
| `Bash` | `bash` |
| `Edit`, `MultiEdit` | `edit` |
| `Write` | `write` |
| `WebFetch` | `fetch` |

- A pi tool name, such as `codemode`, also works if the orchestrator has that tool.
- A name that pi does not have is dropped. The subagent's system prompt says which tools were dropped.
- `fetch` reads a web page as text. Only a subagent whose definition lists `WebFetch` has it. The orchestrator never does. It uses Node's `fetch` with TLS verification on. Its parameters are `url`, `pattern` (keep only the matching lines), and `offset` (read on in a long page).
- An entry such as `mcp__server__tool` gives the subagent that MCP tool, and `codemode`, which is how the subagent calls it.
- A subagent gets MCP servers only if it has no `tools:` line or names an MCP tool. MCP servers cost a process each and seconds to start. A server name or a wildcard (`mcp__server`, `mcp__server__*`) does not count.

### Models

The `model` of a call replaces the `model` of the definition. The value is one of:

- `sonnet`, `opus`, or `haiku`. These are the Claude subscription models that Bifrost serves, `bifrost/claude-sub/claude-<name>-<version>`. If there are several versions, the highest one is used.
- A full `provider/id`, for example `bifrost/icr-qwen/qwen3.8`. The provider is the part before the first slash. The id can contain a slash itself.
- A bare model id without a provider, for example `icr-qwen/qwen3.8`. If more than one provider has it, the orchestrator's provider is used. If the orchestrator's provider does not have it, the call fails and lists the choices.
- `inherit`, the orchestrator's model.

An unknown model or thinking level fails the call before any subagent starts. The error lists the valid values.

The `thinking` of a call replaces the `thinking` of the definition. It takes the same levels.

## Backends

One `agent` tool uses two backends:

- A foreground subagent runs inside the orchestrator's pi, as a separate pi session. Its approval dialogs appear in the orchestrator's pane. The title starts with `[<type>: <description>]`, so you can see which subagent asks.
- A background subagent runs in its own Herdr terminal, if pi-bridge runs inside Herdr (`HC_TERMINAL_ID` is set). The terminal runs an interactive `pi-bridge` that is a child of the orchestrator's terminal. You can watch it and type into it. Its approval dialogs appear in its own window. If pi-bridge does not run inside Herdr, a background subagent runs inside the orchestrator's pi, like a foreground one.

`agent_send`, `agent_stop`, and `agent_status` work the same on both backends. A Herdr subagent shows no tool or token counts in `agent_status`.

## Worktrees

`isolation: "worktree"` gives the subagent its own git worktree and branch. Subagents that edit files in parallel then touch neither your working tree nor each other.

- The worktree is cut from the orchestrator's current `HEAD`. Uncommitted changes are not copied. The working directory must be in a git repository that has a commit.
- The branch is `agent/<id>`. The id is `<type>-<5 characters>`, for example `agent/general-purpose-k3x9p`.
- The worktree is in `<state dir>/worktrees/<repo>-<hash>/<id>`. The state dir is `$SUBAGENT_STATE_DIR`, or `~/.local/state/subagent`.
- When the subagent finishes, the extension removes a worktree that has no commits, no changes, and no ignored files, together with its branch. Otherwise the worktree stays, and the result says where it is and on which branch. The extension never forces a removal.
- A Herdr subagent keeps its terminal open after it finishes, so its worktree is checked when you stop the subagent.
- When pi quits, the extension removes the clean worktrees of background subagents. A worktree that has commits or changes stays.

The `git_commit` tool of the `git-guard` extension asks for your approval before each commit. It does not ask on `integration/*` branches, or on `agent/*` branches in a worktree under `<state dir>/worktrees/`. The identity rules and the AI-attribution check still apply. `git_push` still asks.

## Settings

| Variable | Meaning |
|---|---|
| `SUBAGENT_CONCURRENCY` | The number of subagents that run at the same time. The default is 8. Foreground and background subagents share this limit. The others wait in the state `queued`. A value that is not a number, or is less than 1, means 8. |
| `SUBAGENT_STATE_DIR` | The base folder for worktrees. The default is `~/.local/state/subagent`. `git-guard` reads the same variable. |
| `PI_CODEMODE_MAX_WORKERS` | The number of `codemode` scripts that run at the same time. `bin/pi-bridge` sets it to the `SUBAGENT_CONCURRENCY` limit plus 1, because subagents that run inside the orchestrator share its workers. pi's default of 2 starves parallel subagents. A value above that limit that you set yourself is kept. |

## Transcripts

Each subagent writes its session to a file. It is an ordinary pi session file.

- If the orchestrator has a session file, the transcripts are in a folder next to it: `<session file without .jsonl>.subagents/`. pi's session list does not show them.
- If the orchestrator has no session file (`--no-session`), the transcripts are in `$XDG_STATE_HOME/subagent/transcripts/unsaved/`. If `XDG_STATE_HOME` is not set, the folder is `~/.local/state/subagent/transcripts/unsaved/`.
- A Herdr subagent's file is named `<id>.jsonl`.
- `agent_status` shows the transcript path.

## Design

Foreground subagents run in-process, as an `AgentSession` bound to the orchestrator's UI. Background subagents run as an interactive `pi-bridge` in their own Herdr terminal (`hc run --parent --no-notify`). If pi-bridge is not inside Herdr, they run in-process.

In-process is the only way a delegated session keeps your approval dialogs. In `pi -p` print mode there is no UI, so a child could never approve anything. The orchestrator also still gets structured results, abort, and live progress. Long background work is worth watching, and worth typing into, in its own window. Herdr provides that.

Rejected:

- A `pi -p` child for each subagent. It has no approvals, and you cannot steer it or continue it.
- Herdr for every subagent. It works only inside Herdr, it starts a full pi process for each short lookup, and the result is read from a session file.

Consequences:

- One `agent` tool fronts two backends, so `agent_send`, `agent_stop`, and `agent_status` must behave the same on both.
- A Herdr subagent is finished when its turn advanced past its launch turn and Herdr reports `done`. A bare `idle` at turn 0 is only the startup.
- The extension reads the final message of a Herdr subagent from its session file. The terminal stays open until `agent_stop` or until the orchestrator exits.
- Each in-process subagent opens its own MCP connections. The extension tears it down like a pi session: abort, then `session_shutdown`, then dispose. Dispose alone leaves the MCP servers running.

## Tests

The tests are in `test/subagent/`. See `test/README.md`.
