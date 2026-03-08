#!/usr/bin/env bash
# Conductor install script
# Usage: curl -fsSL https://raw.githubusercontent.com/charannyk06/conductor-oss/main/install.sh | bash

set -e

BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
DIM="\033[2m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}Installing Conductor...${RESET}"
echo ""

# Check Cargo
if ! command -v cargo &>/dev/null; then
  echo "Error: Rust/Cargo is required."
  echo "  Install from https://rustup.rs/"
  exit 1
fi

# Install
cargo install --locked --git https://github.com/charannyk06/conductor-oss conductor-cli

CARGO_BIN_DIR="${CARGO_HOME:-$HOME/.cargo}/bin"
if [ -x "$CARGO_BIN_DIR/conductor" ]; then
  ln -sf "$CARGO_BIN_DIR/conductor" "$CARGO_BIN_DIR/co"
  ln -sf "$CARGO_BIN_DIR/conductor" "$CARGO_BIN_DIR/conductor-oss"
fi

echo ""
echo -e "${GREEN}✔${RESET} Conductor installed!"
echo ""
echo -e "${BOLD}Quick start:${RESET}"
echo -e "  ${CYAN}mkdir my-project && cd my-project${RESET}"
echo -e "  ${CYAN}co init${RESET}              ${DIM}# scaffold kanban board + config${RESET}"
echo -e "  ${CYAN}co start${RESET}             ${DIM}# start the orchestrator${RESET}"
echo ""
echo -e "Also check prerequisites: ${CYAN}tmux${RESET}, ${CYAN}gh${RESET} CLI, ${CYAN}claude${RESET} or ${CYAN}codex${RESET}"
echo -e "Docs: https://github.com/charannyk06/conductor-oss"
echo ""
