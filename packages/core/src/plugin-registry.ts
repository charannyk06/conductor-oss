/**
 * Plugin Registry -- discovers and loads plugins.
 *
 * Plugins can be:
 * 1. Built-in (packages/plugins/*)
 * 2. npm packages (@conductor-oss/plugin-*)
 * 3. Local file paths specified in config
 */

import type {
  PluginSlot,
  PluginManifest,
  PluginModule,
  PluginRegistry,
  OrchestratorConfig,
} from "./types.js";

/** Map from "slot:name" -> plugin instance */
type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

/** Built-in plugin package names, mapped to their npm package */
const BUILTIN_PLUGINS: Array<{ slot: PluginSlot; name: string; pkg: string }> = [
  // Runtimes
  { slot: "runtime", name: "tmux", pkg: "@conductor-oss/plugin-runtime-tmux" },
  // Agents
  { slot: "agent", name: "claude-code", pkg: "@conductor-oss/plugin-agent-claude-code" },
  { slot: "agent", name: "codex", pkg: "@conductor-oss/plugin-agent-codex" },
  // Workspaces
  { slot: "workspace", name: "worktree", pkg: "@conductor-oss/plugin-workspace-worktree" },
  // Trackers
  { slot: "tracker", name: "github", pkg: "@conductor-oss/plugin-tracker-github" },
  // SCM
  { slot: "scm", name: "github", pkg: "@conductor-oss/plugin-scm-github" },
  // Notifiers
  { slot: "notifier", name: "desktop", pkg: "@conductor-oss/plugin-notifier-desktop" },
  { slot: "notifier", name: "discord", pkg: "@conductor-oss/plugin-notifier-discord" },
  // Terminals
  { slot: "terminal", name: "web", pkg: "@conductor-oss/plugin-terminal-web" },
];

/** Extract plugin-specific config from orchestrator config (reserved for future use) */
function extractPluginConfig(
  slot: PluginSlot,
  name: string,
  config: OrchestratorConfig,
): Record<string, unknown> | undefined {
  if (slot === "notifier") {
    // Look up notifiers.<name> in config
    const notifierCfg = (config as unknown as Record<string, unknown>)["notifiers"];
    if (notifierCfg && typeof notifierCfg === "object") {
      const cfg = (notifierCfg as Record<string, unknown>)[name];
      if (cfg && typeof cfg === "object") return cfg as Record<string, unknown>;
    }
  }
  // Future: agent, runtime, workspace plugin configs
  return undefined;
}

export function createPluginRegistry(): PluginRegistry {
  const plugins: PluginMap = new Map();

  return {
    register(plugin: PluginModule, config?: Record<string, unknown>): void {
      const { manifest } = plugin;
      const key = makeKey(manifest.slot, manifest.name);
      const instance = plugin.create(config);
      plugins.set(key, { manifest, instance });
    },

    get<T>(slot: PluginSlot, name: string): T | null {
      const entry = plugins.get(makeKey(slot, name));
      return entry ? (entry.instance as T) : null;
    },

    list(slot: PluginSlot): PluginManifest[] {
      const result: PluginManifest[] = [];
      for (const [key, entry] of plugins) {
        if (key.startsWith(`${slot}:`)) {
          result.push(entry.manifest);
        }
      }
      return result;
    },

    async loadBuiltins(
      orchestratorConfig?: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
    ): Promise<void> {
      const doImport = importFn ?? ((pkg: string) => import(pkg));
      for (const builtin of BUILTIN_PLUGINS) {
        try {
          const mod = (await doImport(builtin.pkg)) as PluginModule;
          if (mod.manifest && typeof mod.create === "function") {
            const pluginConfig = orchestratorConfig
              ? extractPluginConfig(builtin.slot, builtin.name, orchestratorConfig)
              : undefined;
            this.register(mod, pluginConfig);
          }
        } catch {
          // Plugin not installed -- that's fine, only load what's available
        }
      }
    },
  };
}
