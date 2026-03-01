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

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

// Cache in globalThis for Next.js HMR stability
const globalForServices = globalThis as typeof globalThis & {
  _conductorServices?: Services;
  _conductorServicesInit?: Promise<Services>;
};

/** Get (or lazily initialize) the core services singleton. */
export function getServices(): Promise<Services> {
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

  const loadConfig = core.loadConfig as (() => OrchestratorConfig) | undefined;
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

  const config = loadConfig();
  const registry = createPluginRegistry();

  // Load built-in plugins with config for proper initialization
  if (typeof registry.loadBuiltins === "function") {
    await registry.loadBuiltins(config);
  }

  const sessionManager = createSessionManager({ config, registry });

  const services: Services = { config, registry, sessionManager };
  globalForServices._conductorServices = services;
  return services;
}
