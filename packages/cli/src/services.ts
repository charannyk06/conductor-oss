/**
 * Shared service factory for CLI commands.
 *
 * Loads the conductor config (YAML), registers all plugin packages,
 * and creates a SessionManager backed by the core implementation.
 *
 * Every command that needs a SessionManager calls `createServices()` once.
 */

import type {
  OrchestratorConfig,
  SessionManager,
  PluginRegistry,
  PluginModule,
} from "@conductor-oss/core";

// ---- Plugin packages (workspace:* deps in package.json) ----
import runtimeTmux from "@conductor-oss/plugin-runtime-tmux";
import agentClaudeCode from "@conductor-oss/plugin-agent-claude-code";
import agentCodex from "@conductor-oss/plugin-agent-codex";
import agentAmp from "@conductor-oss/plugin-agent-amp";
import agentCursorCli from "@conductor-oss/plugin-agent-cursor-cli";
import agentOpencode from "@conductor-oss/plugin-agent-opencode";
import agentDroid from "@conductor-oss/plugin-agent-droid";
import agentQwenCode from "@conductor-oss/plugin-agent-qwen-code";
import agentCcr from "@conductor-oss/plugin-agent-ccr";
import agentGithubCopilot from "@conductor-oss/plugin-agent-github-copilot";
import workspaceWorktree from "@conductor-oss/plugin-workspace-worktree";
import trackerGithub from "@conductor-oss/plugin-tracker-github";
import scmGithub from "@conductor-oss/plugin-scm-github";
import notifierDiscord from "@conductor-oss/plugin-notifier-discord";
import notifierDesktop from "@conductor-oss/plugin-notifier-desktop";
import agentGemini from "@conductor-oss/plugin-agent-gemini";

/**
 * All known plugin modules.
 * Each is registered into the PluginRegistry at startup.
 */
const ALL_PLUGINS: PluginModule[] = [
  runtimeTmux as PluginModule,
  agentClaudeCode as PluginModule,
  agentCodex as PluginModule,
  agentGemini as PluginModule,
  agentAmp as PluginModule,
  agentCursorCli as PluginModule,
  agentOpencode as PluginModule,
  agentDroid as PluginModule,
  agentQwenCode as PluginModule,
  agentCcr as PluginModule,
  agentGithubCopilot as PluginModule,
  workspaceWorktree as PluginModule,
  trackerGithub as PluginModule,
  scmGithub as PluginModule,
  notifierDiscord as PluginModule,
  notifierDesktop as PluginModule,
];

/** Re-export for convenience. */
export type { OrchestratorConfig, SessionManager };

/**
 * Load config from the standard YAML file.
 * Imported lazily from @conductor-oss/core.
 */
export async function loadConfig(): Promise<OrchestratorConfig> {
  const core = await import("@conductor-oss/core");
  if (typeof core.loadConfig !== "function") {
    throw new Error("@conductor-oss/core does not export loadConfig");
  }
  return core.loadConfig() as OrchestratorConfig;
}

/**
 * Create a PluginRegistry with all built-in plugins registered.
 */
export async function createRegistry(config?: OrchestratorConfig): Promise<PluginRegistry> {
  const core = await import("@conductor-oss/core");
  if (typeof core.createPluginRegistry !== "function") {
    throw new Error("@conductor-oss/core does not export createPluginRegistry");
  }
  const registry: PluginRegistry = core.createPluginRegistry();
  for (const plugin of ALL_PLUGINS) {
    const pluginConfig =
      config && plugin.manifest.slot === "notifier"
        ? config.notifiers?.[plugin.manifest.name]
        : undefined;
    registry.register(plugin, pluginConfig);
  }
  return registry;
}

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

/**
 * Create a fully-wired SessionManager.
 *
 * Loads config, registers plugins, and creates the manager in one call.
 * If you already have the config, pass it to avoid a second file read.
 */
export async function createServices(
  existingConfig?: OrchestratorConfig,
): Promise<Services> {
  const config = existingConfig ?? (await loadConfig());
  const registry = await createRegistry(config);
  const core = await import("@conductor-oss/core");

  if (typeof core.createSessionManager !== "function") {
    throw new Error("@conductor-oss/core does not export createSessionManager");
  }

  const sessionManager: SessionManager = core.createSessionManager({
    config,
    registry,
  });

  return { config, registry, sessionManager };
}
