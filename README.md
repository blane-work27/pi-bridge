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
                                  └──> sub-bridge (this host) ──> Claude Code ──> Anthropic
```

- `sub-bridge` is a small HTTP server in `bridge/server.ts`. It has no npm dependencies.
- `sub-bridge` starts the official `claude` binary for each conversation. Claude Code uses your own login.
- `sub-bridge` never reads or sends your Claude token. Only Claude Code talks to Anthropic.
- Claude Code never talks to the gateway.
- For the `bifrost/auto` model, Bifrost sorts each request into the tier `SIMPLE`, `MEDIUM`, or `COMPLEX`. A small local model (`tev1:0.8b` in the `ollama-pi` container) does the sorting.
- `bifrost/routing.json` gives the model for each tier. If this file is missing, `install.sh` makes it from `bifrost/routing.example.json`.

## Files

| File | Purpose |
|---|---|
| `install.sh` | Sets up and starts everything. You can run it again at any time. |
| `bifrost/routing.json` | The model for each tier, the fallback model, and the extra models that pi shows. You edit this file. Do not commit it. |
| `bifrost/routing.example.json` | A template for `bifrost/routing.json`. It uses only Claude subscription models. |
| `bin/render-bifrost-config.py` | Makes `bifrost/config.json` and `models.json` from `bifrost/routing.json`. |
| `bridge/server.ts` | The server that connects Bifrost to Claude Code. |
| `bin/pi-bridge` | Launcher. It sets `PI_CODING_AGENT_DIR` to this directory and starts pi. |
| `SYSTEM.md` | The pi system prompt for this directory. |
| `settings.json` | pi settings. The default model is `bifrost/claude-sub/claude-opus-5-5`. |
| `.env` | Settings for this machine: the pi binary and the gateway files. You make this file from `.env.example`. Do not commit it. |
| `.env.example` | A template for `.env`. |
| `bifrost/.env`, `bridge/.env` | Secrets. `install.sh` makes them with mode 600. Do not commit them. |

## Prerequisites

1. Make sure that Docker runs and that your user can use it:

   ```bash
   docker ps
   ```

2. Make sure that Claude Code is logged in with your subscription:

   ```bash
   claude auth status
   ```

3. Make sure that `authMethod` is `claude.ai`. If it is not, run `claude auth login`.
4. Make sure that `node --version` shows 22.18 or later.
5. Copy the template for the machine settings:

   ```bash
   cp .env.example .env
   ```

6. In `.env`, set each value:

   | Variable | Value |
   |---|---|
   | `PI_BIN` | The path to the pi binary. If you leave it empty, the scripts use the `pi` command in your `PATH`. |
   | `GATEWAY_MENU` | The path to the gateway model menu. This is an OpenCode-format provider configuration file (JSON). |
   | `GATEWAY_KEY_FILE` | The path to the file that contains your gateway key. |
   | `GATEWAY_CA_FILE` | The path to the CA certificate bundle for the gateway. Leave it empty if the gateway uses a public certificate. |
   | `GATEWAY_KEY_HEADER` | The name of an extra request header that carries the gateway key, if the gateway needs one. Leave it empty if the gateway reads the key only from `Authorization: Bearer`. |

7. If `bifrost/routing.json` uses no gateway models, you can leave the `GATEWAY_` values empty.

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
5. It installs and starts the systemd user service `sub-bridge.service`.
6. It starts the `ollama-pi` container and downloads the tier model.
7. It starts the `bifrost-pi` container.
8. It sends a test request to each model and one test prompt through pi.

## Use pi

1. Go to the project directory that you want to work in.
2. Start pi:

   ```bash
   pi-bridge
   ```

   The command `pi-bridge` is a symlink in `~/.local/bin` to `bin/pi-bridge`. If the symlink is missing, make it:

   ```bash
   ln -s ~/working/personal/pi-config/bin/pi-bridge ~/.local/bin/pi-bridge
   ```

   The command `pi` still starts your default pi setup in `~/.pi/agent`. That setup does not use Bifrost.

3. To pick a model, type `/model` in pi.
4. Select `bifrost/auto` to let Bifrost pick the model for each request.
5. Select a `bifrost/claude-sub/...` model to always use your Claude subscription.

## Change the routing

1. Edit `bifrost/routing.json`.
2. Write each model as `<provider>/<model>`. The provider is `claude-sub`, `openai`, or a provider ID from the gateway menu.
3. Run `install.sh` again.

To add OpenAI models, export `OPENAI_API_KEY` before you run `install.sh`, and use `openai/<model>` in `bifrost/routing.json`.

## Limits and safety

- `sub-bridge` stops a request when Claude Code reports that the request uses Extra Usage. You are not billed for Extra Usage through this setup.
- Anthropic counts a request against your plan only when the system prompt looks like ordinary Claude Code use. `sub-bridge` keeps Claude Code's own system prompt and adds `SYSTEM.md` after it. Do not replace `SYSTEM.md` with a prompt from another tool.
- A conversation on a `claude-sub` model keeps one Claude Code process open while pi runs tools. If pi does not send a tool result for 30 minutes, `sub-bridge` closes the process. The next request starts a new process with the history as text.
- `sub-bridge.service` is a systemd user service. It runs only while you are logged in, unless an administrator turns on lingering for your user.

## Logs

| Component | Command |
|---|---|
| sub-bridge | `journalctl --user -u sub-bridge.service -f` |
| Bifrost | `docker logs -f bifrost-pi` |
| Ollama | `docker logs -f ollama-pi` |

The Bifrost dashboard is at `http://127.0.0.1:8080`. The user is `admin`. The password is `BIFROST_ADMIN_PASSWORD` in `bifrost/.env`.
