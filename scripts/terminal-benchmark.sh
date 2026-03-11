#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/terminal-benchmark.sh <session-id>

Environment:
  CONDUCTOR_DASHBOARD_URL  Dashboard base URL. Default: http://127.0.0.1:3000
  TERMINAL_BENCH_RUNS      Number of runs per endpoint. Default: 3
  TERMINAL_BENCH_LINES     Snapshot line budget. Default: 1200
  TERMINAL_BENCH_COLS      Resize width. Default: 120
  TERMINAL_BENCH_ROWS      Resize height. Default: 32
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

SESSION_ID="$1"
DASHBOARD_URL="${CONDUCTOR_DASHBOARD_URL:-http://127.0.0.1:3000}"
RUNS="${TERMINAL_BENCH_RUNS:-3}"
LINES="${TERMINAL_BENCH_LINES:-1200}"
COLS="${TERMINAL_BENCH_COLS:-120}"
ROWS="${TERMINAL_BENCH_ROWS:-32}"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/conductor-terminal-benchmark.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

extract_header() {
  local name="$1"
  local file="$2"
  awk -v target="$name" '
    BEGIN { IGNORECASE = 1 }
    {
      sub(/\r$/, "", $0)
      split($0, parts, ":")
      if (tolower(parts[1]) == tolower(target)) {
        sub(/^[^:]*:[[:space:]]*/, "", $0)
        print
        exit
      }
    }
  ' "$file"
}

json_summary() {
  local label="$1"
  local body_file="$2"
  node - "$label" "$body_file" <<'NODE'
const fs = require("fs");

const [label, bodyFile] = process.argv.slice(2);
const fieldsByLabel = {
  connection: ["transport", "interactive", "requiresToken", "tokenExpiresInSeconds", "fallbackReason"],
  snapshot_live: ["source", "live", "restored", "format", "snapshotVersion", "sequence"],
  snapshot_readonly: ["source", "live", "restored", "format", "snapshotVersion", "sequence"],
  resize: ["ok", "sessionId", "cols", "rows"],
};

let payload = {};
try {
  payload = JSON.parse(fs.readFileSync(bodyFile, "utf8"));
} catch {
  payload = {};
}

const fields = fieldsByLabel[label] ?? [];
const summary = fields
  .map((field) => [field, payload[field]])
  .filter(([, value]) => value !== undefined && value !== null && value !== "")
  .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
  .join(" ");

process.stdout.write(summary);
NODE
}

run_request() {
  local label="$1"
  local method="$2"
  local url="$3"
  local body="${4-}"
  local file_stub="${label//[^A-Za-z0-9_.-]/_}"
  local headers_file="$WORKDIR/$file_stub.headers"
  local body_file="$WORKDIR/$file_stub.body"
  local curl_args=(
    -sS
    -D "$headers_file"
    -o "$body_file"
    -X "$method"
    -H "Accept: application/json"
  )

  if [[ -n "$body" ]]; then
    curl_args+=(
      -H "Content-Type: application/json"
      --data "$body"
    )
  fi

  local metrics
  metrics="$(curl "${curl_args[@]}" -w 'status=%{http_code} total=%{time_total}s size=%{size_download}B' "$url")"

  local server_timing
  local transport
  local interactive
  local connection_path
  local snapshot_source
  local snapshot_live
  local snapshot_restored
  local summary
  server_timing="$(extract_header "Server-Timing" "$headers_file")"
  transport="$(extract_header "x-conductor-terminal-transport" "$headers_file")"
  interactive="$(extract_header "x-conductor-terminal-interactive" "$headers_file")"
  connection_path="$(extract_header "x-conductor-terminal-connection-path" "$headers_file")"
  snapshot_source="$(extract_header "x-conductor-terminal-snapshot-source" "$headers_file")"
  snapshot_live="$(extract_header "x-conductor-terminal-snapshot-live" "$headers_file")"
  snapshot_restored="$(extract_header "x-conductor-terminal-snapshot-restored" "$headers_file")"
  summary="$(json_summary "$label" "$body_file")"

  printf '%-18s %s' "$label" "$metrics"
  if [[ -n "$server_timing" ]]; then
    printf ' server_timing="%s"' "$server_timing"
  fi
  if [[ -n "$transport" ]]; then
    printf ' transport=%s' "$transport"
  fi
  if [[ -n "$interactive" ]]; then
    printf ' interactive=%s' "$interactive"
  fi
  if [[ -n "$connection_path" ]]; then
    printf ' connection_path=%s' "$connection_path"
  fi
  if [[ -n "$snapshot_source" ]]; then
    printf ' snapshot_source=%s' "$snapshot_source"
  fi
  if [[ -n "$snapshot_live" ]]; then
    printf ' snapshot_live=%s' "$snapshot_live"
  fi
  if [[ -n "$snapshot_restored" ]]; then
    printf ' snapshot_restored=%s' "$snapshot_restored"
  fi
  if [[ -n "$summary" ]]; then
    printf ' %s' "$summary"
  fi
  printf '\n'
}

for run in $(seq 1 "$RUNS"); do
  printf 'run=%s session=%s dashboard=%s\n' "$run" "$SESSION_ID" "$DASHBOARD_URL"
  run_request "connection" "GET" "$DASHBOARD_URL/api/sessions/$SESSION_ID/terminal/connection"
  run_request "snapshot_live" "GET" "$DASHBOARD_URL/api/sessions/$SESSION_ID/terminal/snapshot?lines=$LINES&live=1"
  run_request "resize" "POST" "$DASHBOARD_URL/api/sessions/$SESSION_ID/terminal/resize" "{\"cols\":$COLS,\"rows\":$ROWS}"
  run_request "snapshot_readonly" "GET" "$DASHBOARD_URL/api/sessions/$SESSION_ID/terminal/snapshot?lines=$LINES"
  printf '\n'
done
