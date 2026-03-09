#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
APP_ROOT="${CONDUCTOR_APP_ROOT:-$(dirname "$SCRIPT_DIR")}"
WORKSPACE_ROOT="${CONDUCTOR_WORKSPACE:-${WORKSPACE:-$APP_ROOT}}"
ENV_FILE="${CONDUCTOR_ENV_FILE:-}"

if [ -z "$ENV_FILE" ]; then
  if [ -f "$APP_ROOT/.env.local" ]; then
    ENV_FILE="$APP_ROOT/.env.local"
  elif [ -f "$WORKSPACE_ROOT/.env.local" ]; then
    ENV_FILE="$WORKSPACE_ROOT/.env.local"
  fi
fi

if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

CONFIG="${CO_CONFIG_PATH:-$WORKSPACE_ROOT/conductor.yaml}"
DASHBOARD_PORT="${CONDUCTOR_PROD_DASHBOARD_PORT:-${PORT:-4747}}"
BACKEND_PORT="${CONDUCTOR_PROD_BACKEND_PORT:-${CONDUCTOR_BACKEND_PORT:-4748}}"
BACKEND_BIN="${CONDUCTOR_BACKEND_BIN:-$APP_ROOT/target/release/conductor}"
WEB_DIR="$APP_ROOT/packages/web"
STANDALONE_DIR="$WEB_DIR/.next/standalone"
STANDALONE_SERVER="$STANDALONE_DIR/packages/web/server.js"
SOURCE_STATIC_DIR="$WEB_DIR/.next/static"
TARGET_STATIC_DIR="$STANDALONE_DIR/packages/web/.next/static"

if [ ! -x "$BACKEND_BIN" ]; then
  echo "Missing Rust backend binary at $BACKEND_BIN. Run bun run prod:prepare first." >&2
  exit 1
fi

if [ ! -f "$STANDALONE_SERVER" ]; then
  echo "Missing standalone web server at $STANDALONE_SERVER. Run bun run prod:prepare first." >&2
  exit 1
fi

if [ -d "$SOURCE_STATIC_DIR" ] && [ ! -d "$TARGET_STATIC_DIR" ]; then
  mkdir -p "$(dirname "$TARGET_STATIC_DIR")"
  cp -R "$SOURCE_STATIC_DIR" "$TARGET_STATIC_DIR"
fi

if [ -z "${CONDUCTOR_GITHUB_WEBHOOK_SECRET:-}" ]; then
  echo "Warning: CONDUCTOR_GITHUB_WEBHOOK_SECRET is not set. GitHub webhook signature verification will be disabled." >&2
fi

backend_pid=""

cleanup() {
  if [ -n "$backend_pid" ] && kill -0 "$backend_pid" 2>/dev/null; then
    kill "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

CONDUCTOR_WORKSPACE="$WORKSPACE_ROOT" \
CO_CONFIG_PATH="$CONFIG" \
"$BACKEND_BIN" --workspace "$WORKSPACE_ROOT" --config "$CONFIG" start --host 127.0.0.1 --port "$BACKEND_PORT" &
backend_pid=$!

backend_ready=0
attempt=0
while [ "$attempt" -lt 60 ]; do
  if curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
    backend_ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$backend_ready" -ne 1 ]; then
  echo "Rust backend did not become ready on port $BACKEND_PORT." >&2
  exit 1
fi

echo "Rust backend: http://127.0.0.1:$BACKEND_PORT"
echo "Dashboard:    http://127.0.0.1:$DASHBOARD_PORT"

cd "$STANDALONE_DIR"
CONDUCTOR_WORKSPACE="$WORKSPACE_ROOT" \
CO_CONFIG_PATH="$CONFIG" \
CONDUCTOR_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT" \
PORT="$DASHBOARD_PORT" \
HOSTNAME="0.0.0.0" \
node "$STANDALONE_SERVER"
