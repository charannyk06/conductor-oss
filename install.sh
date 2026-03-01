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

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js 20+ is required."
  echo "  Install from https://nodejs.org or: brew install node"
  exit 1
fi

NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_VER" -lt 20 ]; then
  echo "Error: Node.js 20+ required (found v${NODE_VER})"
  exit 1
fi

# Check npm
if ! command -v npm &>/dev/null; then
  echo "Error: npm is required."
  exit 1
fi

# Install
npm install -g conductor-oss

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
