HERDR_APP_COMMIT="93b097f6e29fcb2d90a30dea2f03ce4e5dee7981"
HERDR_RUST_VERSION="1.95.0"
HERDR_ZIG_VERSION="0.16.0"
HERDR_ZIG_SHA256="70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00"
RUSTUP_VERSION="1.29.3"
RUSTUP_SHA256="b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55"
HERDR_CORE_SHA256="5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="sub-bridge.service"
OLD_UNIT="claude-sub.service"

os_check() {
  [ "$(uname -m)" = "x86_64" ] || die "The RHEL 9 setup supports only x86_64."
  if ! grep -qE '^VERSION_ID="?9' /etc/os-release 2>/dev/null; then
    echo "WARNING: This is not RHEL 9. The RHEL 9 steps can still work on a similar Linux."
  fi
  command -v systemctl >/dev/null || die "'systemctl' is not installed."
}

os_network() {
  HOST_IP="$(docker network inspect "$NETWORK" -f '{{(index .IPAM.Config 0).Gateway}}')"
  [ -n "$HOST_IP" ] || die "Docker network $NETWORK has no gateway address."
  SUB_BIND="$HOST_IP"
  SUB_URL_FOR_CONTAINERS="http://$HOST_IP:$CLAUDE_SUB_PORT"
  SUB_URL_FOR_HOST="http://$HOST_IP:$CLAUDE_SUB_PORT"
}

os_install_herdr() {
  local bin_dir="$HOME/.local/bin" data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
  local app_home="$data_dir/herdr-app"
  local build="$HERDR_APP_VERSION $HERDR_APP_COMMIT rust-$HERDR_RUST_VERSION zig-$HERDR_ZIG_VERSION"
  local image="herdr-app-build:$HERDR_APP_VERSION" tmp cid
  mkdir -p "$bin_dir"
  if [ "$(cat "$app_home/.build" 2>/dev/null)" = "$build" ]; then
    echo "The Herdr app $HERDR_APP_VERSION is already built and installed."
  else
    echo "Building the Herdr app in a Rocky Linux 9 container. The first build takes several minutes."
    docker build -t "$image" -f "$ROOT/herdr/Containerfile" \
      --build-arg RUSTUP_VERSION="$RUSTUP_VERSION" --build-arg RUSTUP_SHA256="$RUSTUP_SHA256" \
      --build-arg RUST_VERSION="$HERDR_RUST_VERSION" \
      --build-arg ZIG_VERSION="$HERDR_ZIG_VERSION" --build-arg ZIG_SHA256="$HERDR_ZIG_SHA256" \
      --build-arg HERDR_APP_VERSION="$HERDR_APP_VERSION" --build-arg HERDR_APP_COMMIT="$HERDR_APP_COMMIT" \
      "$ROOT/herdr" || die "The Herdr app build failed. Read the build output above."
    tmp="$(mktemp -d)"
    cid="$(docker create "$image")"
    docker cp "$cid:/out" "$tmp/herdr-app"
    docker rm "$cid" >/dev/null
    echo "$build" > "$tmp/herdr-app/.build"
    mkdir -p "$data_dir/applications" "$data_dir/icons/hicolor/scalable/apps"
    rm -rf "$app_home"
    mv "$tmp/herdr-app" "$app_home"
    rm -rf "$tmp"
    ln -sfn "$app_home/herdr-app" "$bin_dir/herdr-app"
    cp "$app_home/herdr-app.svg" "$data_dir/icons/hicolor/scalable/apps/herdr-app.svg"
    cat > "$data_dir/applications/herdr-app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Herdr
Comment=Terminals and coding agents that keep running
Exec=$bin_dir/herdr-app
Icon=herdr-app
Terminal=false
Categories=Development;
StartupWMClass=herdr-app
EOF
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data_dir/applications" 2>/dev/null || true
    echo "Installed the Herdr app in $app_home."
  fi
  if [ -x "$bin_dir/herdr-core" ] || command -v herdr-core >/dev/null 2>&1; then
    echo "herdr-core is already installed."
  else
    tmp="$(mktemp -d)"
    fetch_pinned "https://releases.herdr.dev/core/$HERDR_CORE_VERSION/herdr-core-linux-x86_64.tar.gz" "$HERDR_CORE_SHA256" "$tmp/core.tar.gz"
    tar -xzf "$tmp/core.tar.gz" -C "$tmp"
    install -m 755 "$tmp/herdr-core" "$bin_dir/herdr-core"
    command -v hc >/dev/null 2>&1 || [ -e "$bin_dir/hc" ] || ln -s herdr-core "$bin_dir/hc"
    rm -rf "$tmp"
    echo "Installed herdr-core in $bin_dir/herdr-core."
  fi
  rm -f "$bin_dir/herdr"
}

os_install_search_tools() {
  local missing=""
  command -v rg >/dev/null 2>&1 || missing="$missing ripgrep"
  command -v fd >/dev/null 2>&1 || missing="$missing fd-find"
  if [ -z "$missing" ]; then
    echo "ripgrep and fd are already installed."
  else
    echo "WARNING: pi needs$missing. They are in EPEL. Install them with:"
    echo "         sudo dnf install -y epel-release && sudo dnf install -y$missing"
  fi
}

os_start_sub_bridge() {
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
}

os_sub_bridge_log_tail() {
  journalctl --user -u "$UNIT" -n 30 --no-pager >&2
}

SUB_BRIDGE_LOG_COMMAND="journalctl --user -u $UNIT -f"
