/**
 * @conductor-oss/core
 *
 * Shared TypeScript surface for the Rust-first Conductor runtime.
 */

// Types -- everything frontend/launcher consumers need
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
