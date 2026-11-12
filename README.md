# pi-config

This directory is a pi agent directory.
pi sends all model requests to Bifrost, which is an LLM gateway that runs in a local container.
Bifrost sends each request to a model on your gateway or to your Claude subscription.
In this file, the gateway is an OpenAI-compatible model gateway that you have access to. The gateway is optional.

This directory is separate from pi's default agent directory, `~/.pi/agent`.
This setup does not change `~/.pi/agent`.

## How requests flow

```text
pi ──> Bifrost (127.0.0.1:8080) ──┬──> gateway
                                  ├──> sub-bridge (this host) ──> Claude Code ──> Anthropic
                                  └──> /mcp/memory ──> Basic Memory (basic-memory-pi) ──> ~/memory-palace
```

- `sub-bridge` is a small HTTP server in `bridge/server.ts`. It has no npm dependencies.
- `sub-bridge` starts the official `claude` binary for each conversation. Claude Code uses your own login.
- `sub-bridge` never reads or sends your Claude token. Only Claude Code talks to Anthropic.
- Claude Code never talks to the gateway.
- For the `bifrost/auto` model, Bifrost sorts each request into the tier `SIMPLE`, `MEDIUM`, or `COMPLEX`. A small local model (`tev1:0.8b` in the `ollama-pi` container) does the sorting.
- `bifrost/routing.json` gives the model for each tier. If this file is missing, `install.sh` makes it from `bifrost/routing.example.json`.
- Bifrost also serves the memory palace as the MCP server `/mcp/memory`. See [Memory palace](#memory-palace).

## Files

| File | Purpose |
|---|---|
| `install.sh` | Sets up and starts everything. You can run it again at any time. |
| `install.d/rhel9.sh`, `install.d/macos.sh` | The steps that are different on RHEL 9 and on macOS. |
| `bifrost/routing.json` | The model for each tier, the fallback model, and the extra models that pi shows. You edit this file. Do not commit it. |
| `bifrost/routing.example.json` | A template for `bifrost/routing.json`. It uses only Claude subscription models. |
| `bin/render-bifrost-config.py` | Makes `bifrost/config.json` and `models.json` from `bifrost/routing.json`. |
| `bridge/server.ts` | The server that connects Bifrost to Claude Code. |
| `extensions/jank/` | The jank extension. It adds worker, merge, and research tools to pi. |
| `skills/jank/`, `skills/jank-research/` | The pi skills that tell the orchestrator how to use jank. |
| `extensions/git-guard/` | Blocks `git commit` and `git push` in the pi `bash` tool. Adds the `git_commit` and `git_push` tools. |
| `skills/commit/` | The pi skill that reviews changes and writes a commit message with you. |
| `git-identities.json` | The commit email for each git host. You make this file from `git-identities.example.json`. Do not commit it. |
| `herdr/Containerfile` | Builds the Herdr app from source on Rocky Linux 9. |
| `bin/pi-bridge` | Launcher. It sets `PI_CODING_AGENT_DIR` to this directory and starts pi. |
| `SYSTEM.md` | The pi system prompt for this directory. |
| `settings.json` | pi settings. The default model is `bifrost/claude-sub/claude-opus-5-5`. The `codemode` tool is on. |
| `.env` | Settings for this machine: the pi binary and the gateway files. You make this file from `.env.example`. Do not commit it. |
| `.env.example` | A template for `.env`. |
| `bifrost/.env`, `bridge/.env` | Secrets. `install.sh` makes them with mode 600. Do not commit them. |
| `bifrost/checks` | The models that passed the installer test. `install.sh` makes this file. Do not commit it. |
| `mcp.json` | pi's MCP servers. `install.sh` adds the `memory` server. Do not commit it. |

## Prerequisites

This setup runs on two kinds of workstation: RHEL 9 (x86_64) and macOS (Apple silicon). The installer finds the kind of workstation and uses `install.d/rhel9.sh` or `install.d/macos.sh`.

### RHEL 9

1. Make sure that Docker Engine runs and that your user can use it:

   ```bash
   docker ps
   ```

2. Make sure that `systemctl --user status` works. The installer runs sub-bridge as a systemd user service.

### macOS

Docker Desktop is not used. The installer stops if the `docker` CLI connects to Docker Desktop.

1. Install Rancher Desktop from https://rancherdesktop.io.
2. In Rancher Desktop, open **Preferences** > **Container Engine**, and select **dockerd (moby)**.
3. If you do not use Kubernetes, open **Preferences** > **Kubernetes**, and clear **Enable Kubernetes**.
4. Make sure that the `docker` CLI from Rancher Desktop is in your `PATH`, and that it connects:

   ```bash
   docker ps
   ```

5. Install Node.js 22.18 or later, for example with `brew install node`.
6. Make sure that `python3` works. If it does not, install the Xcode command line tools with `xcode-select --install`.
7. To let the installer install Herdr, install Homebrew from https://brew.sh. Homebrew is optional.

### Both workstations

1. Make sure that Claude Code is logged in with your subscription:

   ```bash
   claude auth status
   ```

2. Make sure that `authMethod` is `claude.ai`. If it is not, run `claude auth login`.
3. Make sure that `node --version` shows 22.18 or later.
4. Copy the template for the machine settings:

   ```bash
   cp .env.example .env
   ```

5. In `.env`, set each value:

   | Variable | Value |
   |---|---|
   | `PI_BIN` | The path to the pi binary. If you leave it empty, the scripts use the `pi` command in your `PATH`. |
   | `GATEWAY_MENU` | The path to the gateway model menu. This is an OpenCode-format provider configuration file (JSON). |
   | `GATEWAY_KEY_FILE` | The path to the file that contains your gateway key. |
   | `GATEWAY_CA_FILE` | The path to the CA certificate bundle for the gateway. Leave it empty if the gateway uses a public certificate. |
   | `GATEWAY_KEY_HEADER` | The name of an extra request header that carries the gateway key, if the gateway needs one. Leave it empty if the gateway reads the key only from `Authorization: Bearer`. |

6. If `bifrost/routing.json` uses no gateway models, you can leave the `GATEWAY_` values empty.

## Install

1. Run the installer:

   ```bash
   ~/working/personal/pi-config/install.sh
   ```

2. Make sure that the last step shows `Done`.
3. If a step fails, read the error. The error names the log to examine.

The installer does these steps:

1. It makes the secrets in `bifrost/.env` and `bridge/.env`.
2. It makes the Docker network `pi-llm`.
3. It makes `bifrost/config.json` and `models.json` from `bifrost/routing.json`.
4. It sets pi to use the `bifrost` provider. It removes `pi-claude-bridge` if that package is installed.
5. It installs the Herdr app. On RHEL 9, it builds the app in a container. On macOS, it installs the app with Homebrew.
6. It starts sub-bridge. On RHEL 9, sub-bridge is the systemd user service `sub-bridge.service`. On macOS, sub-bridge is the launchd agent `dev.pi-config.sub-bridge`.
7. It starts the `ollama-pi` container and downloads the tier model.
8. It starts the `basic-memory-pi` container for the memory palace.
9. It starts the `bifrost-pi` container, and makes sure that Bifrost can connect to sub-bridge and that pi can reach the memory palace.
10. It sends a test request to each model and one test prompt through pi.

Containers connect to sub-bridge in a different way on each workstation:

| Workstation | sub-bridge listens on | Bifrost connects to |
|---|---|---|
| RHEL 9 | The gateway address of the Docker network `pi-llm` | The same address |
| macOS | `127.0.0.1` | `host.docker.internal`, which Rancher Desktop sends to the Mac |

The installer records each test that passes in `bifrost/checks`.
On the next run, it skips a test that passed if the configuration for that model did not change.
It always tests again a model that failed.
If a tier model or a fallback model fails, the installer stops. If a model in `models` fails, the installer shows a warning and continues.
To test all models again, run `install.sh --recheck`.
To skip all tests, run `install.sh --no-test`.

## Use pi

1. Go to the project directory that you want to work in.
2. Start pi:

   ```bash
   pi-bridge
   ```

   The command `pi-bridge` is a symlink in `~/.local/bin` to `bin/pi-bridge`. `install.sh` makes it (set `PI_BRIDGE_LINK_DIR` in `.env` to use another directory). To make it by hand:

   ```bash
   ln -sfn "$PWD/bin/pi-bridge" ~/.local/bin/pi-bridge   # run from the repo root
   ```

   The command `pi` still starts your default pi setup in `~/.pi/agent`. That setup does not use Bifrost.

3. To pick a model, type `/model` in pi.
4. Select `bifrost/auto` to let Bifrost pick the model for each request.
5. Select a `bifrost/claude-sub/...` model to always use your Claude subscription.

## Use Herdr

Herdr is a desktop app for terminals and coding agents. Its sidebar shows the state of each agent: working, blocked, done, or idle.
herdr-core runs the terminals. The terminals continue to run when you close the Herdr window.

### RHEL 9

The Linux app needs a desktop session and a Vulkan driver.
The Herdr release for Linux needs glibc 2.35. RHEL 9 has glibc 2.34. For this reason, the installer builds the app from source.
The build runs in a Rocky Linux 9 container, so the app uses the glibc of RHEL 9.
The installer copies the app into `~/.local/share/herdr-app`. It installs herdr-core from the Herdr release, because herdr-core does not use the system glibc.
The installer builds the app again only when the pinned versions in `install.d/rhel9.sh` change.
An app built from source does not update itself.

### macOS

The installer installs the Herdr release with `brew install --cask herdr-app`, if the app is not installed.
If Homebrew is not installed, download https://releases.herdr.dev/app/Herdr.dmg, and drag Herdr to Applications.
The app installs herdr-core when you open it. The app updates itself and herdr-core.

### Start Herdr

1. Open Herdr from your app launcher. On RHEL 9, you can also run `herdr-app`.
2. Open a space in your project directory.
3. In a terminal in that space, run `pi-bridge`.

pi reports its state to Herdr through the terminal. You do not need a Herdr integration for pi.

To change the Herdr app version on RHEL 9:

1. Find the tag on https://github.com/herdrdev/herdr-app/tags.
2. In `install.sh`, set `HERDR_APP_VERSION` to the tag without the `v`. In `install.d/rhel9.sh`, set `HERDR_APP_COMMIT` to the commit of the tag.
3. In the `.github/workflows/release.yml` file of that tag, find `RUST_TOOLCHAIN` and `ZIG_VERSION`. Set `HERDR_RUST_VERSION` and `HERDR_ZIG_VERSION` in `install.d/rhel9.sh` to the same values.
4. If the Zig version changed, set `HERDR_ZIG_SHA256` to the `x86_64-linux` `shasum` for that version in https://ziglang.org/download/index.json.
5. Run `install.sh` again.

## Use jank

jank runs many worker agents in parallel. Claude is the orchestrator. The workers use gateway models through Bifrost.

```text
pi (Claude through sub-bridge) ──> codemode script ──> jank_worker × N ──> pi worker ──> Bifrost ──> gateway
```

- Claude writes a `codemode` script. The script calls `jank_worker` for each part of the task.
- Each worker is a separate pi process on a gateway model. A worker cannot use a `claude-sub` model.
- A worker with a JSON Schema must return data that matches the schema. If the data does not match, jank tries the worker again, up to 3 times.
- At most 4 workers run at the same time. To change this limit, set `JANK_CONCURRENCY` before you start pi.
- Claude Code never sends a request to the gateway. Claude only reads the results of the workers.

To use jank:

1. Start pi with `pi-bridge`.
2. Type `/skill:jank`, and then describe the task. You can also ask for "a jank workflow" in your prompt.

### Workers that change files

A worker with `isolation: "worktree"` works in its own git worktree. It does not change your working tree.

1. jank makes a snapshot of your working tree. The snapshot includes changed and untracked files. It does not change a branch, the index, or the stash.
2. Each worker gets a worktree in `~/.local/state/jank/wt/` from the snapshot.
3. When the worker stops, jank saves its changes as a patch in `~/.local/state/jank/patches/`, and removes the worktree.
4. `jank_merge` combines the patches in a separate worktree. If two patches conflict, a worker can resolve the conflict there.
5. `jank_apply` applies the combined patch to your working tree as unstaged changes.

jank never commits and never stages changes in your working tree. You examine the changes and commit them.

### Research in the background

`jank_research` answers one question from primary sources while you continue to work. It is made for a grilling session, for example with the `grill-with-docs` skill.

1. In the session, ask for research on one narrow question, or let the grilling skill ask for it.
2. The session writes a short brief and starts the research. The research does not get the conversation.
3. A separate orchestrator (Claude) plans the research. Gateway-model workers read the sources and check each claim.
4. The result is one Markdown file in `~/.local/state/jank/research/<repo>/`. Each claim in the file has a link to its source.
5. When the research is done, the session gets a message with the answer and the path of the file.

To see the state of research runs, ask for `jank_research_status`. The files for each run are in `~/.local/state/jank/research/runs/<id>/`. The file `progress.log` shows each step.

## Commit with pi

pi cannot run `git commit` or `git push` in its `bash` tool. pi commits only with the `git_commit` tool and pushes only with the `git_push` tool.

- The author and the committer are your global `user.name` and the email for the host of the push remote. The email comes from `git-identities.json`. A local `user.email` in a repository is not used.
- If the host is not in `git-identities.json`, the tools do not commit or push.
- The tools refuse a message that has a `Co-authored-by` trailer, a "Generated with" line, or other AI attribution.
- Before each commit and each push, pi shows a dialog. The commit or the push occurs only if you accept it.
- `git_push` examines each commit that it will push. If a commit has a different author or committer, or AI attribution in its message, `git_push` does not push. `git_push` never forces a push.

To set up the identities:

1. Copy the template:

   ```bash
   cp git-identities.example.json git-identities.json
   ```

2. In `git-identities.json`, set one email for each git host. The host is the host name in the remote URL, for example `github.com`.

To commit:

1. In pi, type `/skill:commit`, or ask pi to commit.
2. pi examines the changes and asks you questions about them.
3. pi shows a draft message. Tell pi what to change.
4. When the message is correct, accept the commit in the dialog.
5. To push, ask pi to push, and then accept the push in the dialog.

You can still run `git commit` and `git push` yourself in a terminal, or with `!` in pi.

## Change the routing

1. Edit `bifrost/routing.json`.
2. Write each model as `<provider>/<model>`. The provider is `claude-sub`, `openai`, or a provider ID from the gateway menu.
   Gateway Responses rows, such as `icr-gpt56-terra-think/gpt-5.6-terra-responses`, work too. In `/model`, a gateway model offers the thinking levels its gateway row lists.
3. Run `install.sh` again.

To add OpenAI models, export `OPENAI_API_KEY` before you run `install.sh`, and use `openai/<model>` in `bifrost/routing.json`.

The keys in `bifrost/routing.json` are:

| Key | Meaning |
|---|---|
| `tiers` | The model for each tier: `SIMPLE`, `MEDIUM`, and `COMPLEX`. |
| `fallbacks` | The models that Bifrost tries, in this order, when a tier model fails. Bifrost skips the tier model itself. |
| `fallback` | The model for a request that the classifier cannot sort into a tier. If `fallbacks` is missing, this model is also the only fallback. |
| `models` | The extra models that pi shows in `/model`. These models do not change the limits of `bifrost/auto`. |
| `classifier` | The tier model in Ollama and its timeout. |

The limits of `bifrost/auto` are the smallest context window and the smallest output limit of the tier models and `fallback`.

## Memory palace

The memory palace is one folder of Markdown notes that every model shares. The default folder is `~/memory-palace`. To use another folder, set `MEMORY_PALACE_DIR` in `.env`.

- The `basic-memory-pi` container runs [Basic Memory](https://github.com/basicmachines-co/basic-memory) on the folder as the project `palace`. Its index and settings are in `~/.local/state/basic-memory-pi`.
- The container is only on the Docker network `pi-llm`. Basic Memory has no authentication, so only Bifrost connects to it.
- Bifrost serves it at `http://127.0.0.1:8080/mcp/memory`. Clients need the `pi` virtual key in the `x-bf-vk` header. Bifrost does not add the memory tools to model requests.
- pi connects to it through `mcp.json`. The tools are `mcp__memory__memory-bm_search`, `mcp__memory__memory-bm_write`, and so on. Call them from `codemode`, and pass `project="palace"`.
- Claude Code keeps its own memory in `~/.claude/projects/<project>/memory`. To share the palace, make that folder a symlink to `~/memory-palace`.
- jank workers run with `--no-extensions`, so they do not have the memory tools.

Basic Memory changes notes:

- It adds a `permalink` field to the frontmatter of each note when it indexes the note. This cannot be turned off.
- Notes that it writes have `title`, `type`, and `permalink` frontmatter.
- Search is full-text only. Semantic search needs a model download from HuggingFace, which the installer turns off.

## Limits and safety

- `sub-bridge` stops a request when Claude Code reports that the request uses Extra Usage. You are not billed for Extra Usage through this setup.
- Anthropic counts a request against your plan only when the system prompt looks like ordinary Claude Code use. `sub-bridge` keeps Claude Code's own system prompt and adds `SYSTEM.md` after it. Do not replace `SYSTEM.md` with a prompt from another tool.
- A conversation on a `claude-sub` model keeps one Claude Code process open while pi runs tools. If pi does not send a tool result for 30 minutes, `sub-bridge` closes the process. The next request starts a new process with the history as text.
- On RHEL 9, `sub-bridge.service` is a systemd user service. It runs only while you are logged in, unless an administrator turns on lingering for your user.
- On macOS, the launchd agent runs only while you are logged in.

## Logs

| Component | Command |
|---|---|
| sub-bridge on RHEL 9 | `journalctl --user -u sub-bridge.service -f` |
| sub-bridge on macOS | `tail -f ~/Library/Logs/sub-bridge.log` |
| Bifrost | `docker logs -f bifrost-pi` |
| Ollama | `docker logs -f ollama-pi` |
| Basic Memory | `docker logs -f basic-memory-pi`, or `~/.local/state/basic-memory-pi/basic-memory.log` |

The Bifrost dashboard is at `http://127.0.0.1:8080`. The user is `admin`. The password is `BIFROST_ADMIN_PASSWORD` in `bifrost/.env`.
