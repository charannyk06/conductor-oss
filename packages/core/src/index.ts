/**
 * @conductor-oss/core
 *
 * Core library for Conductor v2.
 * Exports all types, config loader, and service implementations.
 */

// Types -- everything plugins and consumers need
export * from "./types.js";

// Config -- YAML loader + validation
export {
  loadConfig,
  loadConfigWithPath,
  normalizeProjectConfigMap,
  validateConfig,
  getDefaultConfig,
  findConfig,
  findConfigFile,
} from "./config.js";

// Scaffolding helpers
export {
  buildConductorBoard,
  buildConductorYaml,
  buildProjectConfigRecord,
} from "./scaffold.js";
export type {
  ConductorYamlScaffoldConfig,
  ScaffoldPreferencesConfig,
  ScaffoldProjectConfig,
} from "./scaffold.js";

// Plugin registry
export { createPluginRegistry } from "./plugin-registry.js";

// Metadata -- flat-file session metadata read/write
export {
  readMetadataRaw,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  reserveSessionId,
  readArchivedMetadataRaw,
} from "./metadata.js";

// Session manager -- session CRUD
export { createSessionManager } from "./session-manager.js";
export type { SessionManagerDeps } from "./session-manager.js";

// Lifecycle manager -- state machine + reaction engine
export { createLifecycleManager } from "./lifecycle-manager.js";
export type { LifecycleManagerDeps } from "./lifecycle-manager.js";

// Prompt builder -- layered prompt composition
export { buildPrompt, BASE_AGENT_PROMPT } from "./prompt-builder.js";
export type { PromptBuildConfig } from "./prompt-builder.js";

// Shared utilities
export { shellEscape, validateUrl, readLastJsonlEntry } from "./utils.js";

// Path utilities -- hash-based directory structure
export {
  generateConfigHash,
  generateProjectId,
  generateInstanceId,
  generateSessionPrefix,
  getProjectBaseDir,
  getSessionsDir,
  getWorktreesDir,
  getArchiveDir,
  getOriginFilePath,
  generateSessionName,
  generateTmuxName,
  parseTmuxName,
  expandHome,
  validateAndStoreOrigin,
} from "./paths.js";
export { resolveConfiguredProjectPath } from "./project-paths.js";

// Board watcher -- Obsidian CONDUCTOR.md integration
export {
  createBoardWatcher,
  discoverBoards,
  buildBoardProjectMap,
  syncWorkspaceSupportFiles,
} from "./board-watcher.js";
export type {
  BoardWatcherConfig,
  BoardWatcher,
  WorkspaceSupportFilesSyncOptions,
} from "./board-watcher.js";

// Board diagnostics + doctor helpers
export {
  recordWatcherAction,
  readRecentWatcherActions,
  resolveBoardAliasesForPath,
  parseBoardStatus,
  boardEntriesToPaths,
  defaultAliasMapping,
} from "./board-diagnostics.js";
export type {
  WatcherAction,
  BoardParseStatus,
  DoctorReport,
} from "./board-diagnostics.js";

// Structured board parsing helpers
export {
  DEFAULT_COLUMN_ALIASES,
  parseBoardSections,
  resolveColumnsFromBoard,
  parseChecklistItems,
  getUncheckedTasks,
} from "./board-parser.js";

// Webhook emitter
export { createWebhookEmitter } from "./webhook-emitter.js";
export type { WebhookEmitter, WebhookEmitterConfig, WebhookTarget, WebhookMetrics } from "./webhook-emitter.js";

// Event bus
export { createEventBus } from "./event-bus.js";
export type { EventBus, EventBusConfig, EventBusMetrics, EventFilter, EventSubscriber } from "./event-bus.js";

// Spawn limiter
export { createSpawnLimiter } from "./spawn-limiter.js";
export type { SpawnLimiter, SpawnLimiterConfig, SpawnLimiterMetrics } from "./spawn-limiter.js";

// Config sync and drift detection
export {
  detectConfigDrift,
  syncAllProjectConfigs,
  startupConfigSync,
} from "./config-sync.js";
export type {
  ConfigDriftReport,
  ConfigSyncResult,
} from "./config-sync.js";

// Re-export generation marker from scaffold
export { GENERATED_MARKER_KEY } from "./scaffold.js";
