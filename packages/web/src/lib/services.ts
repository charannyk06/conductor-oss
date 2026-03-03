/**
 * Server-side singleton for core services.
 *
 * Lazily initializes config, plugin registry, and session manager.
 * Cached in globalThis to survive Next.js HMR reloads in development.
 */

import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
} from "@conductor-oss/core/types";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

// Cache in globalThis for Next.js HMR stability
const globalForServices = globalThis as typeof globalThis & {
  _conductorServices?: Services;
  _conductorServicesInit?: Promise<Services>;
  _conductorServicesConfigPath?: string;
  _conductorServicesConfigMtimeMs?: number;
};

function expandHomePath(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function findConfigFromWorkspace(workspace?: string): string | undefined {
  if (!workspace) return undefined;

  const workspacePath = expandHomePath(workspace);
  const directConfigPath = resolve(workspacePath, "conductor.yaml");
  if (existsSync(directConfigPath)) {
    return directConfigPath;
  }

  const conductorDir = resolve(homedir(), ".conductor");
  if (!existsSync(conductorDir)) {
    return undefined;
  }

  try {
    for (const entry of readdirSync(conductorDir)) {
      const originPath = join(conductorDir, entry, ".origin");
      if (!existsSync(originPath)) continue;

      const stat = statSync(originPath);
      if (!stat.isFile()) continue;

      const resolvedOrigin = resolve(readFileSync(originPath, "utf8").trim());
      if (resolvedOrigin !== workspacePath) continue;

      const originConfigYaml = `${resolvedOrigin}/conductor.yaml`;
      if (existsSync(originConfigYaml)) {
        return originConfigYaml;
      }

      const originConfigYml = `${resolvedOrigin}/conductor.yml`;
      if (existsSync(originConfigYml)) {
        return originConfigYml;
      }

      if (
        existsSync(resolvedOrigin) && [
          ".yaml",
          ".yml",
        ].some((ext) => resolvedOrigin.endsWith(ext)) &&
        statSync(resolvedOrigin).isFile()
      ) {
        return resolvedOrigin;
      }
    }
  } catch {
    // Ignore workspace metadata lookup failures.
  }

  return undefined;
}

function getConfigStateFromEnv(): { path: string | undefined } {
  const envConfigPath = process.env["CO_CONFIG_PATH"];
  const workspaceConfigPath = findConfigFromWorkspace(process.env["CONDUCTOR_WORKSPACE"]);

  return {
    path: envConfigPath || workspaceConfigPath,
  };
}

function getConfigMtimeMs(configPath: string | undefined): number | undefined {
  if (!configPath) return undefined;
  try {
    const stats = statSync(configPath);
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}

function clearCachedServices(reason = "stale config"): void {
  globalForServices._conductorServices = undefined;
  globalForServices._conductorServicesInit = undefined;
  globalForServices._conductorServicesConfigPath = undefined;
  globalForServices._conductorServicesConfigMtimeMs = undefined;
  console.info(`[conductor:web] service cache reset (${reason})`);
}

/** Get (or lazily initialize) the core services singleton. */
export function getServices(): Promise<Services> {
  const configState = getConfigStateFromEnv();
  const configPath = configState.path;
  const configMtimeMs = getConfigMtimeMs(configPath);

  if (globalForServices._conductorServices) {
    if (configPath !== globalForServices._conductorServicesConfigPath) {
      clearCachedServices("configuration path changed");
    } else if (
      configPath &&
      configMtimeMs !== undefined &&
      globalForServices._conductorServicesConfigMtimeMs !== undefined &&
      configMtimeMs !== globalForServices._conductorServicesConfigMtimeMs
    ) {
      clearCachedServices("configuration changed on disk");
    }
  }

  if (globalForServices._conductorServices) {
    return Promise.resolve(globalForServices._conductorServices);
  }
  if (!globalForServices._conductorServicesInit) {
    globalForServices._conductorServicesInit = initServices().catch((err) => {
      // Clear cached promise so the next call retries
      globalForServices._conductorServicesInit = undefined;
      throw err;
    });
  }
  return globalForServices._conductorServicesInit;
}

async function initServices(): Promise<Services> {
  // Dynamic import to avoid bundling issues with server-only modules.
  // These will be provided by the core package once plugins are wired.
  // For now, we attempt to import from core's main entry.
  const core = await import("@conductor-oss/core");

  const loadConfig = core.loadConfig as ((configPath?: string) => OrchestratorConfig) | undefined;
  const createPluginRegistry = core.createPluginRegistry as (() => PluginRegistry) | undefined;
  const createSessionManager = core.createSessionManager as
    | ((deps: { config: OrchestratorConfig; registry: PluginRegistry }) => SessionManager)
    | undefined;

  if (!loadConfig || !createPluginRegistry || !createSessionManager) {
    throw new Error(
      "Core package does not export required functions (loadConfig, createPluginRegistry, createSessionManager). " +
      "Ensure @conductor-oss/core is built and exports these."
    );
  }

  const envConfig = getConfigStateFromEnv();
  const configPath = envConfig.path;
  const config = configPath ? loadConfig(configPath) : loadConfig();
  const registry = createPluginRegistry();

  // Load built-in plugins with config for proper initialization
  if (typeof registry.loadBuiltins === "function") {
    await registry.loadBuiltins(config);
  }

  const sessionManager = createSessionManager({ config, registry });

  const services: Services = { config, registry, sessionManager };
  globalForServices._conductorServices = services;
  globalForServices._conductorServicesConfigPath = config.configPath;
  globalForServices._conductorServicesConfigMtimeMs = getConfigMtimeMs(config.configPath);
  return services;
}
