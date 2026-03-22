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
LOCAL_GO_ROOT="$HOME/.local/go"

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
  ensure_path_line "$HOME/.profile" 'export PATH="$HOME/.local/bin:$PATH"'

  user_shell="$(basename "\${SHELL:-}")"
  if [ "$user_shell" = "zsh" ]; then
    ensure_path_line "$HOME/.zshrc" 'export PATH="$HOME/.local/bin:$PATH"'
    ensure_path_line "$HOME/.zshrc" 'export GOROOT="$HOME/.local/go"'
    ensure_path_line "$HOME/.zshrc" 'export PATH="$GOROOT/bin:$PATH"'
  elif [ "$user_shell" = "bash" ]; then
    ensure_path_line "$HOME/.bashrc" 'export PATH="$HOME/.local/bin:$PATH"'
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

configure_shell_path
install_go_if_missing
build_bridge

echo "Installed conductor-bridge to $INSTALL_BIN_DIR/conductor-bridge"
echo "Open a new terminal or run: source ~/.zshrc"
echo "If you want to keep using this terminal, run: export PATH=\"$HOME/.local/bin:$PATH\""
echo "Then run: conductor-bridge connect --dashboard-url <your dashboard URL>"
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
