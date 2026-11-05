#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
BIFROST_IMAGE="maximhq/bifrost:v2.4.0"
OLLAMA_IMAGE="ollama/ollama:0.40.14"
HERDR_APP_VERSION="0.1.13"
HERDR_APP_COMMIT="93b097f6e29fcb2d90a30dea2f03ce4e5dee7981"
HERDR_RUST_VERSION="1.95.0"
HERDR_ZIG_VERSION="0.16.0"
HERDR_ZIG_SHA256="70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00"
RUSTUP_VERSION="1.29.3"
RUSTUP_SHA256="b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55"
HERDR_CORE_VERSION="0.1.18"
HERDR_CORE_SHA256="5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7"
NETWORK="pi-llm"
BIFROST_NAME="bifrost-pi"
OLLAMA_NAME="ollama-pi"
BIFROST_PORT="${BIFROST_PORT:-8080}"
CLAUDE_SUB_PORT="${CLAUDE_SUB_PORT:-8090}"
[ -f "$ROOT/.env" ] || { echo "ERROR: $ROOT/.env is missing. Copy .env.example to .env and set the values." >&2; exit 1; }
set -a
. "$ROOT/.env"
set +a
PI_BIN="${PI_BIN:-$(command -v pi || true)}"
GATEWAY_MENU="${GATEWAY_MENU:-}"
GATEWAY_KEY_FILE="${GATEWAY_KEY_FILE:-}"
GATEWAY_CA_FILE="${GATEWAY_CA_FILE:-}"
GATEWAY_KEY_HEADER="${GATEWAY_KEY_HEADER:-}"
ENV_FILE="$ROOT/bifrost/.env"
SUB_ENV_FILE="$ROOT/bridge/.env"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="sub-bridge.service"
OLD_UNIT="claude-sub.service"
RUN_TEST=1
RECHECK=0
CHECKS_FILE="$ROOT/bifrost/checks"

for arg in "$@"; do
  case "$arg" in
    --no-test) RUN_TEST=0 ;;
    --recheck) RECHECK=1 ;;
    -h|--help) echo "Usage: $0 [--no-test] [--recheck]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

env_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1; }
env_set() {
  local file="$1" name="$2" value="$3" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  { grep -v "^$name=" "$file" 2>/dev/null || true; printf '%s=%s\n' "$name" "$value"; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

step "Check prerequisites"
for cmd in docker python3 openssl claude tar curl node systemctl; do
  command -v "$cmd" >/dev/null || die "'$cmd' is not installed."
done
[ -n "$PI_BIN" ] && [ -x "$PI_BIN" ] || die "pi is not at '$PI_BIN'. Set PI_BIN in .env to the pi binary."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "sub-bridge needs Node 22.18 or later. This node is $(node --version)."
docker info >/dev/null 2>&1 || die "Docker is not running, or your user cannot use it."
claude auth status 2>/dev/null | python3 -I -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("loggedIn") and d.get("authMethod")=="claude.ai" else 1)' \
  || die "Claude Code is not logged in with a Claude subscription. Run 'claude auth login', then run this script again."
NODE_BIN="$(readlink -f "$(command -v node)")"
CLAUDE_BIN="$(readlink -f "$(command -v claude)")"
echo "Prerequisites OK."

step "Write secrets"
mkdir -p "$ROOT/bifrost" "$ROOT/bridge"
for f in "$ENV_FILE" "$SUB_ENV_FILE"; do touch "$f"; chmod 600 "$f"; done
[ -n "$(env_get "$ENV_FILE" BIFROST_VK_PI)" ] || env_set "$ENV_FILE" BIFROST_VK_PI "sk-bf-$(openssl rand -hex 24)"
[ -n "$(env_get "$ENV_FILE" BIFROST_ADMIN_PASSWORD)" ] || env_set "$ENV_FILE" BIFROST_ADMIN_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=')"
[ -n "$(env_get "$ENV_FILE" CLAUDE_SUB_KEY)" ] || env_set "$ENV_FILE" CLAUDE_SUB_KEY "$(openssl rand -hex 32)"
sed -i '/^ANTHROPIC_/d' "$ENV_FILE"
echo "Secrets are in bifrost/.env and bridge/.env (mode 600)."

step "Create the Docker network"
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
HOST_IP="$(docker network inspect "$NETWORK" -f '{{(index .IPAM.Config 0).Gateway}}')"
[ -n "$HOST_IP" ] || die "Docker network $NETWORK has no gateway address."
echo "Network $NETWORK is ready. Containers reach this host at $HOST_IP."

step "Render bifrost/config.json and models.json from bifrost/routing.json"
if [ ! -f "$ROOT/bifrost/routing.json" ]; then
  cp "$ROOT/bifrost/routing.example.json" "$ROOT/bifrost/routing.json"
  echo "Made bifrost/routing.json from bifrost/routing.example.json."
fi
NEEDS="$(python3 -I "$ROOT/bin/render-bifrost-config.py" \
  --routing "$ROOT/bifrost/routing.json" --gateway-menu "$GATEWAY_MENU" --gateway-ca "$GATEWAY_CA_FILE" --gateway-key-header "$GATEWAY_KEY_HEADER" \
  --claude-sub-url "http://$HOST_IP:$CLAUDE_SUB_PORT" \
  --vk-command "!sed -n 's/^BIFROST_VK_PI=//p' $ENV_FILE" \
  --bifrost-url "http://127.0.0.1:$BIFROST_PORT/anthropic" \
  --out "$ROOT/bifrost/config.json" --pi-models-out "$ROOT/models.json")"
for name in $NEEDS; do
  case "$name" in
    GATEWAY_KEY)
      [ -n "$GATEWAY_KEY_FILE" ] && [ -s "$GATEWAY_KEY_FILE" ] || die "routing.json uses gateway models, but GATEWAY_KEY_FILE in .env is not set or the file is empty."
      env_set "$ENV_FILE" GATEWAY_KEY "$(tr -d '\r\n' < "$GATEWAY_KEY_FILE")"
      ;;
    OPENAI_API_KEY)
      if [ -z "$(env_get "$ENV_FILE" OPENAI_API_KEY)" ]; then
        [ -n "${OPENAI_API_KEY:-}" ] || die "routing.json uses OpenAI models. Export OPENAI_API_KEY, then run this script again."
        env_set "$ENV_FILE" OPENAI_API_KEY "$OPENAI_API_KEY"
      fi
      ;;
  esac
done
echo "Wrote bifrost/config.json and models.json."

step "Configure pi to use Bifrost"
if PI_CODING_AGENT_DIR="$ROOT" "$PI_BIN" list 2>/dev/null | grep -q 'pi-claude-bridge'; then
  for src in $(python3 -I -c 'import json,sys; print(" ".join(p for p in json.load(open(sys.argv[1])).get("packages",[]) if "pi-claude-bridge" in p))' "$ROOT/settings.json"); do
    PI_CODING_AGENT_DIR="$ROOT" PI_TELEMETRY=0 "$PI_BIN" remove "$src"
  done
fi
rm -rf "$ROOT/claude-bridge.json" "$ROOT/claude-bridge" "$ROOT/claude-bridge.log" "$ROOT/cc-cli-logs"
python3 -I - "$ROOT" <<'EOF'
import json, os, sys
root = sys.argv[1]
path = os.path.join(root, "settings.json")
s = json.load(open(path))
s["packages"] = [p for p in s.get("packages", []) if "pi-claude-bridge" not in p]
if not s["packages"]:
    s.pop("packages")
s["defaultProvider"] = "bifrost"
s["defaultModel"] = "claude-sub/claude-opus-5-5"
json.dump(s, open(path, "w"), indent=2)
open(path, "a").write("\n")
auth = os.path.join(root, "auth.json")
if os.path.exists(auth):
    a = json.load(open(auth))
    a.pop("claude-bridge", None)
    if a:
        json.dump(a, open(auth, "w"), indent=2)
    else:
        os.remove(auth)
EOF
python3 -I -c 'import json,sys; sys.exit(1 if json.load(open(sys.argv[1])).get("packages") else 0)' "$ROOT/settings.json" && rm -rf "$ROOT/npm"
chmod 600 "$ROOT/models.json"
echo "pi uses provider 'bifrost'. The default model is claude-sub/claude-opus-5-5."

step "Build and install the Herdr app $HERDR_APP_VERSION, and install herdr-core $HERDR_CORE_VERSION"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
HERDR_APP_HOME="$DATA_DIR/herdr-app"
fetch_herdr() {
  local url="$1" sha="$2" out="$3"
  curl -fsSLo "$out" "$url"
  echo "$sha  $out" | sha256sum -c --quiet - || die "The download from $url does not match its pinned SHA-256."
}
[ "$(uname -sm)" = "Linux x86_64" ] || die "This step installs Herdr only on Linux x86_64. Install it by hand from https://herdr.dev/download/."
mkdir -p "$BIN_DIR"
HERDR_APP_BUILD="$HERDR_APP_VERSION $HERDR_APP_COMMIT rust-$HERDR_RUST_VERSION zig-$HERDR_ZIG_VERSION"
HERDR_IMAGE="herdr-app-build:$HERDR_APP_VERSION"
if [ "$(cat "$HERDR_APP_HOME/.build" 2>/dev/null)" = "$HERDR_APP_BUILD" ]; then
  echo "The Herdr app $HERDR_APP_VERSION is already built and installed."
else
  echo "Building the Herdr app in a Rocky Linux 9 container. The first build takes several minutes."
  docker build -t "$HERDR_IMAGE" -f "$ROOT/herdr/Containerfile" \
    --build-arg RUSTUP_VERSION="$RUSTUP_VERSION" --build-arg RUSTUP_SHA256="$RUSTUP_SHA256" \
    --build-arg RUST_VERSION="$HERDR_RUST_VERSION" \
    --build-arg ZIG_VERSION="$HERDR_ZIG_VERSION" --build-arg ZIG_SHA256="$HERDR_ZIG_SHA256" \
    --build-arg HERDR_APP_VERSION="$HERDR_APP_VERSION" --build-arg HERDR_APP_COMMIT="$HERDR_APP_COMMIT" \
    "$ROOT/herdr" || die "The Herdr app build failed. Read the build output above."
  TMP_HERDR="$(mktemp -d)"
  CID="$(docker create "$HERDR_IMAGE")"
  docker cp "$CID:/out" "$TMP_HERDR/herdr-app"
  docker rm "$CID" >/dev/null
  echo "$HERDR_APP_BUILD" > "$TMP_HERDR/herdr-app/.build"
  mkdir -p "$DATA_DIR/applications" "$DATA_DIR/icons/hicolor/scalable/apps"
  rm -rf "$HERDR_APP_HOME"
  mv "$TMP_HERDR/herdr-app" "$HERDR_APP_HOME"
  rm -rf "$TMP_HERDR"
  ln -sfn "$HERDR_APP_HOME/herdr-app" "$BIN_DIR/herdr-app"
  cp "$HERDR_APP_HOME/herdr-app.svg" "$DATA_DIR/icons/hicolor/scalable/apps/herdr-app.svg"
  cat > "$DATA_DIR/applications/herdr-app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Herdr
Comment=Terminals and coding agents that keep running
Exec=$BIN_DIR/herdr-app
Icon=herdr-app
Terminal=false
Categories=Development;
StartupWMClass=herdr-app
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA_DIR/applications" 2>/dev/null || true
  echo "Installed the Herdr app in $HERDR_APP_HOME."
fi
if [ -x "$BIN_DIR/herdr-core" ] || command -v herdr-core >/dev/null 2>&1; then
  echo "herdr-core is already installed."
else
  TMP_HERDR="$(mktemp -d)"
  fetch_herdr "https://releases.herdr.dev/core/$HERDR_CORE_VERSION/herdr-core-linux-x86_64.tar.gz" "$HERDR_CORE_SHA256" "$TMP_HERDR/core.tar.gz"
  tar -xzf "$TMP_HERDR/core.tar.gz" -C "$TMP_HERDR"
  install -m 755 "$TMP_HERDR/herdr-core" "$BIN_DIR/herdr-core"
  command -v hc >/dev/null 2>&1 || [ -e "$BIN_DIR/hc" ] || ln -s herdr-core "$BIN_DIR/hc"
  rm -rf "$TMP_HERDR"
  echo "Installed herdr-core in $BIN_DIR/herdr-core."
fi
rm -f "$BIN_DIR/herdr" "$ROOT/extensions/herdr-agent-state.ts"
rmdir "$ROOT/extensions" 2>/dev/null || true

step "Start sub-bridge"
env_set "$SUB_ENV_FILE" CLAUDE_SUB_KEY "$(env_get "$ENV_FILE" CLAUDE_SUB_KEY)"
env_set "$SUB_ENV_FILE" CLAUDE_SUB_HOST "$HOST_IP"
env_set "$SUB_ENV_FILE" CLAUDE_SUB_PORT "$CLAUDE_SUB_PORT"
env_set "$SUB_ENV_FILE" CLAUDE_SUB_CLAUDE_BIN "$CLAUDE_BIN"
if [ -f "$UNIT_DIR/$OLD_UNIT" ]; then
  systemctl --user disable --now "$OLD_UNIT" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$OLD_UNIT"
fi
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=sub-bridge: Claude subscription endpoint for Bifrost
After=default.target

[Service]
Type=simple
EnvironmentFile=$SUB_ENV_FILE
ExecStart=$NODE_BIN $ROOT/bridge/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null 2>&1
systemctl --user restart "$UNIT"
for _ in $(seq 30); do curl -sf "http://$HOST_IP:$CLAUDE_SUB_PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://$HOST_IP:$CLAUDE_SUB_PORT/health" >/dev/null || { journalctl --user -u "$UNIT" -n 30 --no-pager >&2; die "sub-bridge did not start."; }
echo "sub-bridge is listening on http://$HOST_IP:$CLAUDE_SUB_PORT."

step "Start Ollama for the complexity classifier"
CLASSIFIER_MODEL="$(python3 -I -c 'import json,sys; print((json.load(open(sys.argv[1])).get("classifier") or {}).get("model","tev1:0.8b"))' "$ROOT/bifrost/routing.json")"
docker pull -q "$OLLAMA_IMAGE" >/dev/null
if [ "$(docker inspect -f '{{.Config.Image}}' "$OLLAMA_NAME" 2>/dev/null || true)" != "$OLLAMA_IMAGE" ]; then
  docker rm -f "$OLLAMA_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$OLLAMA_NAME" --restart unless-stopped --network "$NETWORK" \
    -e OLLAMA_KEEP_ALIVE=-1 -v ollama-pi-data:/root/.ollama "$OLLAMA_IMAGE" >/dev/null
fi
docker start "$OLLAMA_NAME" >/dev/null
for _ in $(seq 30); do docker exec "$OLLAMA_NAME" ollama list >/dev/null 2>&1 && break; sleep 1; done
docker exec "$OLLAMA_NAME" ollama pull "$CLASSIFIER_MODEL" 2>&1 | tail -1
echo "Ollama is serving $CLASSIFIER_MODEL."

step "Start Bifrost"
docker pull -q "$BIFROST_IMAGE" >/dev/null
docker rm -f "$BIFROST_NAME" >/dev/null 2>&1 || true
docker create --name "$BIFROST_NAME" --restart unless-stopped --network "$NETWORK" \
  -p "127.0.0.1:$BIFROST_PORT:8080" --env-file "$ENV_FILE" \
  -e APP_HOST=0.0.0.0 -e APP_PORT=8080 -v bifrost-pi-data:/app/data "$BIFROST_IMAGE" >/dev/null
tar -c --owner=1000 --group=0 --mode=0644 -C "$ROOT/bifrost" config.json | docker cp - "$BIFROST_NAME:/app/data/"
docker start "$BIFROST_NAME" >/dev/null
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$BIFROST_PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://127.0.0.1:$BIFROST_PORT/health" >/dev/null || { docker logs --tail 30 "$BIFROST_NAME" >&2; die "Bifrost did not become healthy."; }
echo "Bifrost is healthy on http://127.0.0.1:$BIFROST_PORT."

if [ "$RUN_TEST" = 1 ]; then
  step "Call each model through Bifrost"
  [ "$RECHECK" = 0 ] || rm -f "$CHECKS_FILE"
  touch "$CHECKS_FILE"
  chmod 600 "$CHECKS_FILE"
  VK="$(env_get "$ENV_FILE" BIFROST_VK_PI)"
  KEYS="$(python3 -I - "$ROOT" "$BIFROST_IMAGE" "$PI_BIN" <<'EOF'
import hashlib, json, os, sys
root, image, pi_bin = sys.argv[1:4]
def digest(*parts):
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()
def file_hash(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest() if os.path.exists(path) else ""
config = json.load(open(os.path.join(root, "bifrost/config.json")))
bridge = file_hash(os.path.join(root, "bridge/server.ts"))
models = [m["id"] for m in json.load(open(os.path.join(root, "models.json")))["providers"]["bifrost"]["models"] if m["id"] != "auto"]
for m in models:
    provider = m.split("/", 1)[0]
    print(digest(image, m, config["providers"].get(provider), bridge if provider == "claude-sub" else ""), m)
files = ["bifrost/config.json", "models.json", "settings.json", "SYSTEM.md", "bridge/server.ts"]
print(digest(image, os.path.realpath(pi_bin), *[file_hash(os.path.join(root, f)) for f in files]), "pi:bifrost/auto")
EOF
)"
  REQUIRED="$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(" ".join({*r["tiers"].values(), r.get("fallback", "claude-sub/claude-opus-5-5"), *r.get("fallbacks", [])}))' "$ROOT/bifrost/routing.json")"
  FAILED=""
  WARNED=""
  while read -r key model; do
    [ "$model" != "pi:bifrost/auto" ] || continue
    if grep -qx "$key $model" "$CHECKS_FILE"; then
      echo "$model: OK (cached)"
      continue
    fi
    RESP="$(curl -s -m 60 "http://127.0.0.1:$BIFROST_PORT/anthropic/v1/messages" -H "x-bf-vk: $VK" -H 'anthropic-version: 2023-06-01' \
      -H 'content-type: application/json' -d "{\"model\":\"$model\",\"max_tokens\":300,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: ok\"}]}" || true)"
    if echo "$RESP" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("content") else 1)' 2>/dev/null; then
      echo "$model: OK"
      echo "$key $model" >> "$CHECKS_FILE"
    else
      echo "$model: FAILED ${RESP:-no response in 60s}" | head -c 600; echo
      case " $REQUIRED " in
        *" $model "*) FAILED="$FAILED $model" ;;
        *) WARNED="$WARNED $model" ;;
      esac
    fi
  done <<< "$KEYS"
  [ -z "$WARNED" ] || echo "WARNING: These extra models failed:$WARNED. pi still shows them in /model. Run $0 again to test them again."
  [ -z "$FAILED" ] || die "These tier or fallback models failed:$FAILED. bifrost/auto needs them. Check the gateway, or change them in bifrost/routing.json."

  step "Send a test prompt through pi with the auto model"
  PI_KEY="$(echo "$KEYS" | grep ' pi:bifrost/auto$')"
  if grep -qx "$PI_KEY" "$CHECKS_FILE"; then
    echo "pi with bifrost/auto: OK (cached)"
  else
    OUT="$(cd /tmp && timeout 300 "$ROOT/bin/pi-bridge" --model bifrost/auto -p "Reply with exactly: pi auto ok" 2>&1 || true)"
    echo "$OUT" | tail -3
    echo "$OUT" | grep -q "pi auto ok" || die "The test prompt failed. Look at 'docker logs $BIFROST_NAME' and 'journalctl --user -u $UNIT'."
    echo "$PI_KEY" >> "$CHECKS_FILE"
  fi
fi

step "Done"
cat <<EOF
Start pi:          $ROOT/bin/pi-bridge
Pick a model:      /model in pi. bifrost/auto lets Bifrost choose; bifrost/claude-sub/* uses your Claude subscription.
Bifrost dashboard: http://127.0.0.1:$BIFROST_PORT  (user: admin, password: BIFROST_ADMIN_PASSWORD in bifrost/.env)
sub-bridge logs:   journalctl --user -u $UNIT -f
Change routing:    edit bifrost/routing.json, then run $0 again.
EOF
