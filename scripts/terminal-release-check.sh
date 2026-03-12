#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bun test scripts/terminal-benchmark.test.mjs
bun test \
  'packages/web/src/app/api/sessions/[id]/terminal/connection/route.test.ts' \
  'packages/web/src/app/api/sessions/[id]/terminal/snapshot/route.test.ts' \
  'packages/web/src/app/api/sessions/[id]/terminal/resize/route.test.ts' \
  'packages/web/src/components/sessions/sessionTerminalUtils.test.ts'
cargo test -p conductor-server --test terminal_validation_test -- --nocapture
