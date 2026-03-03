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
  validateConfig,
  getDefaultConfig,
  findConfig,
  findConfigFile,
} from "./config.js";

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

// Board watcher -- Obsidian CONDUCTOR.md integration
export {
  createBoardWatcher,
  discoverBoards,
  buildBoardProjectMap,
} from "./board-watcher.js";
export type { BoardWatcherConfig, BoardWatcher } from "./board-watcher.js";

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
