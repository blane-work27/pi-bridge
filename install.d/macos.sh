LAUNCH_LABEL="dev.pi-config.sub-bridge"
LAUNCH_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"
SUB_BRIDGE_LOG="$HOME/Library/Logs/sub-bridge.log"

os_check() {
  [ "$(uname -m)" = "arm64" ] || die "The macOS setup supports only Apple silicon (arm64)."
  local os
  os="$(docker info -f '{{.OperatingSystem}}' 2>/dev/null || true)"
  case "$os" in
    *"Docker Desktop"*) die "Docker is Docker Desktop. This setup uses Rancher Desktop with the dockerd (moby) engine." ;;
  esac
  docker info -f '{{.ServerVersion}}' >/dev/null 2>&1 || die "The docker CLI cannot reach dockerd. In Rancher Desktop, set Container Engine to dockerd (moby)."
}

os_network() {
  SUB_BIND="127.0.0.1"
  SUB_URL_FOR_CONTAINERS="http://host.docker.internal:$CLAUDE_SUB_PORT"
  SUB_URL_FOR_HOST="http://127.0.0.1:$CLAUDE_SUB_PORT"
}

os_install_herdr() {
  if [ -d "$HOME/Applications/Herdr.app" ] || [ -d "/Applications/Herdr.app" ]; then
    echo "The Herdr app is already installed. It updates itself and herdr-core."
  elif command -v brew >/dev/null 2>&1; then
    brew install --cask herdr-app || die "brew could not install the Herdr app."
    echo "Installed the Herdr app. Open it once, and it installs herdr-core."
  else
    echo "WARNING: The Herdr app is not installed, and Homebrew is not available."
    echo "         Download https://releases.herdr.dev/app/Herdr.dmg and drag Herdr to Applications."
  fi
}

os_install_search_tools() {
  local missing=""
  command -v rg >/dev/null 2>&1 || missing="$missing ripgrep"
  command -v fd >/dev/null 2>&1 || missing="$missing fd"
  if [ -z "$missing" ]; then
    echo "ripgrep and fd are already installed."
  elif command -v brew >/dev/null 2>&1; then
    brew install $missing || die "brew could not install$missing."
    echo "Installed$missing."
  else
    echo "WARNING: pi needs$missing, and Homebrew is not available. Install them, then restart pi."
  fi
}

os_start_sub_bridge() {
  mkdir -p "$(dirname "$LAUNCH_PLIST")" "$(dirname "$SUB_BRIDGE_LOG")"
  python3 -I - "$LAUNCH_PLIST" "$LAUNCH_LABEL" "$NODE_BIN" "$SUB_ENV_FILE" "$ROOT/bridge/server.ts" "$SUB_BRIDGE_LOG" "$PATH" "$HOME" <<'EOF'
import plistlib, sys
path, label, node, env_file, server, log, env_path, home = sys.argv[1:9]
plistlib.dump({
    "Label": label,
    "ProgramArguments": [node, f"--env-file={env_file}", server],
    "EnvironmentVariables": {"PATH": env_path, "HOME": home},
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 5,
    "StandardOutPath": log,
    "StandardErrorPath": log,
}, open(path, "wb"))
EOF
  local domain="gui/$(id -u)" i
  launchctl bootout "$domain/$LAUNCH_LABEL" >/dev/null 2>&1 || true
  # bootout returns before the old job is gone. Until it is, bootstrap fails with "5: Input/output error".
  for i in $(seq 10); do launchctl print "$domain/$LAUNCH_LABEL" >/dev/null 2>&1 || break; sleep 1; done
  for i in 1 2 3 4 5; do
    launchctl bootstrap "$domain" "$LAUNCH_PLIST" 2>/dev/null && break
    [ "$i" -lt 5 ] || { launchctl bootstrap "$domain" "$LAUNCH_PLIST"; die "launchctl could not load $LAUNCH_PLIST."; }
    sleep 2
  done
  launchctl kickstart -k "$domain/$LAUNCH_LABEL" >/dev/null 2>&1 || true
}

os_sub_bridge_log_tail() {
  tail -n 30 "$SUB_BRIDGE_LOG" >&2 2>/dev/null || true
}

SUB_BRIDGE_LOG_COMMAND="tail -f $SUB_BRIDGE_LOG"
