import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GO_VERSION = "1.26.1";

function resolveGoArchiveUrl(): string {
  return [
    'case "${OS}:${ARCH}" in',
    '  "Darwin:arm64") GO_ARCHIVE_URL="https://go.dev/dl/go1.26.1.darwin-arm64.tar.gz" ;;',
    '  "Darwin:x86_64") GO_ARCHIVE_URL="https://go.dev/dl/go1.26.1.darwin-amd64.tar.gz" ;;',
    '  "Linux:arm64"|"Linux:aarch64") GO_ARCHIVE_URL="https://go.dev/dl/go1.26.1.linux-arm64.tar.gz" ;;',
    '  "Linux:x86_64"|"Linux:amd64") GO_ARCHIVE_URL="https://go.dev/dl/go1.26.1.linux-amd64.tar.gz" ;;',
    '  *)',
    '    echo "Unsupported platform: ${OS} ${ARCH}" >&2',
    "    exit 1",
    "    ;;",
    "esac",
  ].join("\n");
}

function resolveSourceArchiveUrl(): string {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (commitSha) {
    return `https://codeload.github.com/charannyk06/conductor-oss/tar.gz/${commitSha}`;
  }

  return "https://codeload.github.com/charannyk06/conductor-oss/tar.gz/refs/heads/main";
}

function buildInstallScript(sourceArchiveUrl: string): string {
  return `#!/bin/sh
set -eu

GO_VERSION="${GO_VERSION}"
SOURCE_ARCHIVE_URL="${sourceArchiveUrl}"
INSTALL_BIN_DIR="\${CONDUCTOR_INSTALL_BIN:-$HOME/.local/bin}"
SERVICE_BIN_DIR="$HOME/.conductor/bin"
LOCAL_GO_ROOT="$HOME/.local/go"
BRIDGE_BIN="$INSTALL_BIN_DIR/conductor-bridge"
CONDUCTOR_WRAPPER_DIR="$HOME/.conductor/bin"
CONNECT_AFTER_INSTALL=0
CONNECT_DASHBOARD_URL=""
CONNECT_RELAY_URL=""
CONNECT_NO_BROWSER=0

print_usage() {
  cat <<'EOF'
Usage:
  curl -fsSL <install-url> | sh
  curl -fsSL <install-url> | sh -s -- --connect --dashboard-url URL [--relay-url URL] [--no-browser]
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --connect)
        CONNECT_AFTER_INSTALL=1
        ;;
      --dashboard-url)
        shift
        if [ "$#" -eq 0 ]; then
          echo "Missing value for --dashboard-url" >&2
          exit 1
        fi
        CONNECT_DASHBOARD_URL="$1"
        ;;
      --relay-url)
        shift
        if [ "$#" -eq 0 ]; then
          echo "Missing value for --relay-url" >&2
          exit 1
        fi
        CONNECT_RELAY_URL="$1"
        ;;
      --no-browser)
        CONNECT_NO_BROWSER=1
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        print_usage >&2
        exit 1
        ;;
    esac
    shift
  done
}

ensure_path_line() {
  target_file="$1"
  path_line="$2"

  mkdir -p "$(dirname "$target_file")"
  touch "$target_file"
  if ! grep -Fqs "$path_line" "$target_file"; then
    printf "\\n%s\\n" "$path_line" >>"$target_file"
  fi
}

configure_shell_path() {
  ensure_path_line "$HOME/.profile" 'export PATH="$HOME/.conductor/bin:$HOME/.local/bin:$PATH"'

  user_shell="$(basename "\${SHELL:-}")"
  if [ "$user_shell" = "zsh" ]; then
    ensure_path_line "$HOME/.zshrc" 'export PATH="$HOME/.conductor/bin:$HOME/.local/bin:$PATH"'
    ensure_path_line "$HOME/.zshrc" 'export GOROOT="$HOME/.local/go"'
    ensure_path_line "$HOME/.zshrc" 'export PATH="$GOROOT/bin:$PATH"'
  elif [ "$user_shell" = "bash" ]; then
    ensure_path_line "$HOME/.bashrc" 'export PATH="$HOME/.conductor/bin:$HOME/.local/bin:$PATH"'
    ensure_path_line "$HOME/.bashrc" 'export GOROOT="$HOME/.local/go"'
    ensure_path_line "$HOME/.bashrc" 'export PATH="$GOROOT/bin:$PATH"'
  fi
}

install_go_if_missing() {
  if command -v go >/dev/null 2>&1; then
    GO_BIN="$(command -v go)"
    return
  fi

  OS="$(uname -s)"
  ARCH="$(uname -m)"
${resolveGoArchiveUrl()
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
  curl -fsSL "$GO_ARCHIVE_URL" -o "$TMP_DIR/go.tar.gz"
  rm -rf "$LOCAL_GO_ROOT"
  mkdir -p "$HOME/.local"
  tar -C "$HOME/.local" -xzf "$TMP_DIR/go.tar.gz"
  GO_BIN="$LOCAL_GO_ROOT/bin/go"
}

build_bridge() {
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

  curl -fsSL "$SOURCE_ARCHIVE_URL" -o "$TMP_DIR/source.tar.gz"
  tar -C "$TMP_DIR" -xzf "$TMP_DIR/source.tar.gz"
  SOURCE_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR/bridge-cmd" ]; then
    echo "Failed to locate bridge source in downloaded archive." >&2
    exit 1
  fi

  mkdir -p "$INSTALL_BIN_DIR"
  (cd "$SOURCE_DIR/bridge-cmd" && GOBIN="$INSTALL_BIN_DIR" "$GO_BIN" build -o "$INSTALL_BIN_DIR/conductor-bridge" .)
  chmod +x "$INSTALL_BIN_DIR/conductor-bridge"
}

resolve_conductor_command_path() {
  for candidate in \
    "$CONDUCTOR_WRAPPER_DIR/conductor" \
    "$CONDUCTOR_WRAPPER_DIR/co" \
    "$HOME/.local/bin/conductor" \
    "$HOME/.local/bin/co" \
    "/opt/homebrew/bin/conductor" \
    "/opt/homebrew/bin/co" \
    "/usr/local/bin/conductor" \
    "/usr/local/bin/co" \
    "/usr/bin/conductor" \
    "/usr/bin/co"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v conductor >/dev/null 2>&1; then
    command -v conductor
    return 0
  fi
  if command -v co >/dev/null 2>&1; then
    command -v co
    return 0
  fi

  return 1
}

ensure_conductor_cli() {
  if resolve_conductor_command_path >/dev/null 2>&1; then
    return
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "Conductor CLI is not installed and npm is unavailable." >&2
    echo "Install conductor-oss manually or set CONDUCTOR_BRIDGE_BACKEND_COMMAND before running the bridge." >&2
    return
  fi

  echo "Installing conductor-oss CLI..."
  if ! npm install -g conductor-oss; then
    CONDUCTOR_CMD="$(resolve_conductor_command_path || true)"
    if [ -n "$CONDUCTOR_CMD" ]; then
      echo "Using existing Conductor CLI at $CONDUCTOR_CMD"
    else
      echo "Retrying conductor-oss install with --force to replace an existing co shim..."
      npm install -g conductor-oss --force
    fi
  fi

  CONDUCTOR_CMD="$(resolve_conductor_command_path || true)"
  if [ -z "$CONDUCTOR_CMD" ]; then
    NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
    if [ -n "$NPM_PREFIX" ]; then
      if [ -x "$NPM_PREFIX/bin/conductor" ]; then
        CONDUCTOR_CMD="$NPM_PREFIX/bin/conductor"
      elif [ -x "$NPM_PREFIX/bin/co" ]; then
        CONDUCTOR_CMD="$NPM_PREFIX/bin/co"
      fi
    fi
  fi

  if [ -z "$CONDUCTOR_CMD" ]; then
    echo "Installed conductor-oss but could not locate the CLI binary." >&2
    return
  fi

  mkdir -p "$CONDUCTOR_WRAPPER_DIR"
  ln -sf "$CONDUCTOR_CMD" "$CONDUCTOR_WRAPPER_DIR/conductor"
  ln -sf "$CONDUCTOR_CMD" "$CONDUCTOR_WRAPPER_DIR/co"
}

install_bridge_service() {
  "$INSTALL_BIN_DIR/conductor-bridge" install
  if [ -x "$SERVICE_BIN_DIR/conductor-bridge" ]; then
    BRIDGE_BIN="$SERVICE_BIN_DIR/conductor-bridge"
  fi
}

run_connect_if_requested() {
  if [ "$CONNECT_AFTER_INSTALL" -ne 1 ]; then
    return
  fi

  if [ -z "$CONNECT_DASHBOARD_URL" ]; then
    echo "--dashboard-url is required when using --connect" >&2
    exit 1
  fi

  set -- connect --dashboard-url "$CONNECT_DASHBOARD_URL"
  if [ -n "$CONNECT_RELAY_URL" ]; then
    set -- "$@" --relay-url "$CONNECT_RELAY_URL"
  fi
  if [ "$CONNECT_NO_BROWSER" -eq 1 ]; then
    set -- "$@" --no-browser
  fi

  echo "Starting Conductor Bridge pairing..."
  exec "$BRIDGE_BIN" "$@"
}

parse_args "$@"
configure_shell_path
install_go_if_missing
build_bridge
ensure_conductor_cli
install_bridge_service

echo "Installed conductor-bridge to $INSTALL_BIN_DIR/conductor-bridge"
echo "Bridge service installed. Future reconnects can use: conductor-bridge connect --dashboard-url <your dashboard URL>"
run_connect_if_requested
`;
}

export async function GET(): Promise<Response> {
  return new NextResponse(buildInstallScript(resolveSourceArchiveUrl()), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
}
