#!/usr/bin/env bash
# validate-docs.sh — verify docs/manifest.json stays in sync with actual code
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO_ROOT/docs/manifest.json"
AGENTS_DIR="$REPO_ROOT/crates/conductor-executors/src/agents"
COMMANDS_DIR="$REPO_ROOT/packages/cli/src/commands"
ERRORS=0

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: docs/manifest.json not found at $MANIFEST"
  exit 1
fi

echo "Validating docs/manifest.json against source code..."
echo

# Check agents — each manifest agent id should have a matching .rs file
# Map agent id to Rust filename: claude-code -> claude_code, github-copilot -> copilot, etc.
agent_ids=$(jq -r '.agents[].id' "$MANIFEST")
for agent_id in $agent_ids; do
  # Convert id to possible Rust filenames
  rs_name=$(echo "$agent_id" | tr '-' '_')
  found=false

  # Direct match
  if [ -f "$AGENTS_DIR/${rs_name}.rs" ]; then
    found=true
  fi

  # Special cases: github-copilot -> copilot, cursor-cli -> cursor, qwen-code -> qwen
  if [ "$found" = false ]; then
    case "$agent_id" in
      github-copilot)
        [ -f "$AGENTS_DIR/copilot.rs" ] && found=true ;;
      cursor-cli)
        [ -f "$AGENTS_DIR/cursor.rs" ] && found=true ;;
      qwen-code)
        [ -f "$AGENTS_DIR/qwen.rs" ] && found=true ;;
    esac
  fi

  if [ "$found" = true ]; then
    echo "  ✓ agent '$agent_id' has matching Rust executor"
  else
    echo "  ✗ agent '$agent_id' — no matching .rs file in $AGENTS_DIR"
    ERRORS=$((ERRORS + 1))
  fi
done

echo

# Check CLI commands — each manifest command should have a matching .ts file
commands=$(jq -r '.cliCommands[]' "$MANIFEST")
for cmd in $commands; do
  ts_file="$COMMANDS_DIR/${cmd}.ts"
  if [ -f "$ts_file" ]; then
    echo "  ✓ command '$cmd' has matching TypeScript file"
  else
    echo "  ✗ command '$cmd' — no matching .ts file in $COMMANDS_DIR"
    ERRORS=$((ERRORS + 1))
  fi
done

echo
if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: $ERRORS item(s) in docs/manifest.json have no matching source file."
  echo "Update docs/manifest.json or add the missing source files."
  exit 1
else
  echo "PASSED: all manifest entries have matching source files."
  exit 0
fi
