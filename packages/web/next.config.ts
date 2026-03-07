import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    turbopackFileSystemCacheForBuild: true,
  },
  serverExternalPackages: [
    "@conductor-oss/core",
    "@conductor-oss/plugin-agent-amp",
    "@conductor-oss/plugin-agent-ccr",
    "@conductor-oss/plugin-agent-claude-code",
    "@conductor-oss/plugin-agent-codex",
    "@conductor-oss/plugin-agent-cursor-cli",
    "@conductor-oss/plugin-agent-droid",
    "@conductor-oss/plugin-agent-gemini",
    "@conductor-oss/plugin-agent-github-copilot",
    "@conductor-oss/plugin-agent-opencode",
    "@conductor-oss/plugin-agent-qwen-code",
    "@conductor-oss/plugin-notifier-desktop",
    "@conductor-oss/plugin-notifier-discord",
    "@conductor-oss/plugin-runtime-tmux",
    "@conductor-oss/plugin-scm-github",
    "@conductor-oss/plugin-terminal-web",
    "@conductor-oss/plugin-tracker-github",
    "@conductor-oss/plugin-workspace-worktree",
  ],
  // Silence "multiple lockfiles" warning — pin workspace root to the monorepo
  outputFileTracingRoot: resolve(process.cwd(), "../../"),
};

export default nextConfig;
