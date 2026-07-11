#!/usr/bin/env bash
# validate-docs.sh — bidirectionally verify docs/manifest.json against source.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO_ROOT/docs/manifest.json"
AGENTS_DIR="$REPO_ROOT/crates/conductor-executors/src/agents"
COMMANDS_DIR="$REPO_ROOT/packages/cli/src/commands"
MCP_SOURCE="$REPO_ROOT/crates/conductor-server/src/mcp.rs"
ROUTES_DIR="$REPO_ROOT/crates/conductor-server/src/routes"
SETUP_SOURCE="$REPO_ROOT/packages/cli/src/commands/setup.ts"
UPDATE_SOURCE="$REPO_ROOT/crates/conductor-executors/src/update.rs"
ERRORS=0

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: docs/manifest.json not found at $MANIFEST"
  exit 1
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

if ! jq -e '
  .schemaVersion == 1
  and (.agents | type == "array" and length > 0)
  and (.cliCommands | type == "array")
  and (.mcpTools | type == "array")
  and (.features | type == "array")
  and (.apiRoutes | type == "array")
  and (([.agents[].id] | length) == ([.agents[].id] | unique | length))
  and ((.cliCommands | length) == (.cliCommands | unique | length))
  and ((.mcpTools | length) == (.mcpTools | unique | length))
  and ((.features | length) == (.features | unique | length))
  and ((.apiRoutes | length) == (.apiRoutes | unique | length))
  and all(.agents[];
    (.id | type == "string" and length > 0)
    and (.binary | type == "string" and length > 0)
    and (.aliases | type == "array" and length > 0 and length == (unique | length))
    and (.website | type == "string" and length > 0)
    and (.brandColor | test("^#[0-9A-Fa-f]{6}$"))
    and ((has("installCommand") | not) or (.installCommand | type == "string" and length > 0)))
' "$MANIFEST" >/dev/null; then
  echo "ERROR: docs/manifest.json does not match schema version 1."
  exit 1
fi

compare_sets() {
  local label="$1"
  local source_file="$2"
  local manifest_file="$3"
  local missing_file="$tmp_dir/${label// /_}.missing"
  local stale_file="$tmp_dir/${label// /_}.stale"

  sort -u "$source_file" > "$source_file.sorted"
  sort -u "$manifest_file" > "$manifest_file.sorted"
  comm -23 "$source_file.sorted" "$manifest_file.sorted" > "$missing_file"
  comm -13 "$source_file.sorted" "$manifest_file.sorted" > "$stale_file"

  if [ -s "$missing_file" ]; then
    while IFS= read -r entry; do
      echo "  ✗ $label '$entry' exists in source but is missing from the manifest"
      ERRORS=$((ERRORS + 1))
    done < "$missing_file"
  fi
  if [ -s "$stale_file" ]; then
    while IFS= read -r entry; do
      echo "  ✗ $label '$entry' exists in the manifest but not in source"
      ERRORS=$((ERRORS + 1))
    done < "$stale_file"
  fi
  if [ ! -s "$missing_file" ] && [ ! -s "$stale_file" ]; then
    echo "  ✓ $label entries exactly match source"
  fi
}

echo "Validating docs/manifest.json against source code..."

for file in "$AGENTS_DIR"/*.rs; do
  name=$(basename "$file" .rs)
  [ "$name" = "mod" ] && continue
  case "$name" in
    claude_code) echo "claude-code" ;;
    copilot) echo "github-copilot" ;;
    cursor) echo "cursor-cli" ;;
    qwen) echo "qwen-code" ;;
    *) echo "${name//_/-}" ;;
  esac
done > "$tmp_dir/source-agents"
jq -r '.agents[].id' "$MANIFEST" > "$tmp_dir/manifest-agents"
compare_sets "agent" "$tmp_dir/source-agents" "$tmp_dir/manifest-agents"

find "$COMMANDS_DIR" -maxdepth 1 -type f -name '*.ts' -exec basename {} .ts \; \
  > "$tmp_dir/source-commands"
jq -r '.cliCommands[]' "$MANIFEST" > "$tmp_dir/manifest-commands"
compare_sets "CLI command" "$tmp_dir/source-commands" "$tmp_dir/manifest-commands"

sed -nE 's/^const TOOL_[A-Z0-9_]+: &str = "([^"]+)";/\1/p' "$MCP_SOURCE" \
  > "$tmp_dir/source-mcp-tools"
jq -r '.mcpTools[]' "$MANIFEST" > "$tmp_dir/manifest-mcp-tools"
compare_sets "MCP tool" "$tmp_dir/source-mcp-tools" "$tmp_dir/manifest-mcp-tools"

for file in "$ROUTES_DIR"/*.rs; do
  name=$(basename "$file" .rs)
  case "$name" in
    api_error|middleware|mod|ttyd_protocol|*_tests) continue ;;
  esac
  echo "${name//_/-}"
done > "$tmp_dir/source-api-routes"
jq -r '.apiRoutes[]' "$MANIFEST" > "$tmp_dir/manifest-api-routes"
compare_sets "API route group" "$tmp_dir/source-api-routes" "$tmp_dir/manifest-api-routes"

# Every setup-supported agent must publish an installation command, while
# gateway-only executors such as OpenClaw may intentionally omit one.
sed -n '/const byAgent: Record/,/^  };/p' "$SETUP_SOURCE" \
  | sed -nE 's/^    "?([a-z0-9-]+)"?: \{$/\1/p' \
  > "$tmp_dir/source-installable-agents"
jq -r '.agents[] | select(has("installCommand")) | .id' "$MANIFEST" \
  > "$tmp_dir/manifest-installable-agents"
compare_sets "installable agent" \
  "$tmp_dir/source-installable-agents" \
  "$tmp_dir/manifest-installable-agents"

while IFS=$'\t' read -r agent_id install_command; do
  if ! grep -Fq -- "${install_command#npm install -g }" "$SETUP_SOURCE"; then
    echo "  ✗ install command for '$agent_id' is not represented by CLI setup metadata"
    ERRORS=$((ERRORS + 1))
  fi
done < <(jq -r '.agents[] | select(has("installCommand")) | [.id, .installCommand] | @tsv' "$MANIFEST")

sed -nE 's/^            package: "([^"]+)",/\1/p' "$UPDATE_SOURCE" \
  > "$tmp_dir/source-auto-update-packages"
jq -r '
  .agents[]
  | select(.id != "hermes" and .installCommand? != null and (.installCommand | startswith("npm install -g ")))
  | .installCommand
  | sub("^npm install -g "; "")
' "$MANIFEST" > "$tmp_dir/manifest-auto-update-packages"
compare_sets "executor auto-update package" \
  "$tmp_dir/source-auto-update-packages" \
  "$tmp_dir/manifest-auto-update-packages"

if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: $ERRORS manifest/source mismatch(es)."
  exit 1
fi

echo "PASSED: source-backed manifest catalogs are bidirectionally aligned; feature declarations are schema-valid."
