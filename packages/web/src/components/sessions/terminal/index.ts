/**
 * Barrel file for the terminal/ module.
 * Re-exports all public APIs from the terminal subsystem.
 */

// Constants
export {
  LIVE_TERMINAL_STATUSES,
  RESUMABLE_STATUSES,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  RENDERER_RECOVERY_THROTTLE_MS,
  TERMINAL_WRITE_BATCH_MAX_DELAY_MS,
  TERMINAL_HTTP_CONTROL_BATCH_MAX_DELAY_MS,
  DESKTOP_TERMINAL_SCROLLBACK,
  MOBILE_TERMINAL_SCROLLBACK,
  LIVE_TERMINAL_SCROLLBACK,
  READ_ONLY_TERMINAL_SNAPSHOT_LINES,
  TERMINAL_CONNECTION_CACHE_MAX_TTL_MS,
  TERMINAL_CONNECTION_CACHE_MAX_ENTRIES,
  TERMINAL_SNAPSHOT_CACHE_MAX_ENTRIES,
  TERMINAL_UI_STATE_CACHE_MAX_ENTRIES,
  TERMINAL_SNAPSHOT_CACHE_MAX_AGE_MS,
  TERMINAL_UI_STATE_CACHE_MAX_AGE_MS,
  LIVE_TERMINAL_HELPER_KEYS,
} from "./terminalConstants";

// Types
export type {
  SessionTerminalProps,
  TerminalConnectionInfo,
  TerminalSnapshot,
  TerminalServerEvent,
  TerminalStreamEventMessage,
  PreferredFocusTarget,
  PendingTerminalHttpControlOperation,
  CachedTerminalConnection,
  CachedTerminalSnapshot,
  CachedTerminalUiState,
  TerminalCoreClientModules,
  TerminalModeState,
  TerminalViewportState,
  TerminalInsertRequest,
  TerminalHttpControlOperation,
} from "./terminalTypes";

// Cache
export {
  terminalConnectionCache,
  terminalSnapshotCache,
  terminalUiStateCache,
  trimTerminalCache,
  readCachedTerminalConnection,
  storeCachedTerminalConnection,
  clearCachedTerminalConnection,
  readCachedTerminalSnapshot,
  storeCachedTerminalSnapshot,
  clearCachedTerminalSnapshot,
  readCachedTerminalUiState,
  storeCachedTerminalUiState,
} from "./terminalCache";

// API
export {
  parseTerminalModes,
  fetchTerminalConnection,
  fetchTerminalSnapshot,
  fetchSessionStatus,
  postSessionTerminalKeys,
  postTerminalResize,
} from "./terminalApi";

// Helpers
export {
  decodeTerminalPayloadToString,
  shellEscapePath,
  shellEscapePaths,
  extractClipboardFiles,
  localFileTransferError,
  buildReadableSnapshotPayload,
  terminalHasRenderedContent,
  shouldShowTerminalAccessoryBar,
} from "./terminalHelpers";

// Addon loading
export {
  loadTerminalCoreClientModules,
  loadTerminalSearchAddonModule,
  loadTerminalWebglAddonModule,
  loadTerminalUnicode11AddonModule,
  loadTerminalWebLinksAddonModule,
} from "./useTerminalAddons";

// Hooks
export { useTerminalSearch } from "./useTerminalSearch";
export type { UseTerminalSearchOptions, UseTerminalSearchReturn } from "./useTerminalSearch";

export { useTerminalInput } from "./useTerminalInput";
export type { UseTerminalInputReturn } from "./useTerminalInput";

export { useTerminalConnection } from "./useTerminalConnection";
export type { UseTerminalConnectionReturn } from "./useTerminalConnection";

export { useTerminalResize } from "./useTerminalResize";
export type { UseTerminalResizeReturn } from "./useTerminalResize";

export { useTerminalSnapshot } from "./useTerminalSnapshot";
export type { UseTerminalSnapshotReturn } from "./useTerminalSnapshot";
