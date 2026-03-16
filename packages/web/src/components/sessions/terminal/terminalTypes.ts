/**
 * Interfaces, type aliases, and enums used by the terminal subsystem.
 * TTyD WebSocket is the sole transport — all legacy SSE/HTTP types removed.
 */

import type { TerminalViewportState } from "../terminalViewport";
import type { TerminalInsertRequest } from "../terminalInsert";

export type { TerminalModeState } from "../sessionTerminalUtils";
export type { TerminalViewportState } from "../terminalViewport";
export type { TerminalInsertRequest } from "../terminalInsert";

export interface SessionTerminalProps {
  sessionId: string;
  agentName: string;
  projectId: string;
  sessionModel: string;
  sessionReasoningEffort: string;
  sessionState: string;
  active: boolean;
  pendingInsert: TerminalInsertRequest | null;
  immersiveMobileMode?: boolean;
}

export type TerminalConnectionInfo = {
  ptyWsUrl: string | null;
  interactive: boolean;
};

export type TerminalSnapshot = {
  snapshot: string;
  transcript: string;
  source: string;
  live: boolean;
  restored: boolean;
  sequence: number | null;
  modes?: import("../sessionTerminalUtils").TerminalModeState;
};

export type PreferredFocusTarget = "none" | "terminal" | "resume";

export type CachedTerminalConnection = {
  value: TerminalConnectionInfo;
  expiresAt: number;
};

export type CachedTerminalSnapshot = TerminalSnapshot & {
  updatedAt: number;
};

export type CachedTerminalUiState = {
  message: string;
  searchOpen: boolean;
  searchQuery: string;
  helperPanelOpen: boolean;
  viewport: TerminalViewportState | null;
  updatedAt: number;
};

export type TerminalCoreClientModules = [
  typeof import("@xterm/xterm"),
  typeof import("@xterm/addon-fit"),
];

declare global {
  interface Window {
    __conductorSessionTerminalDebug?: {
      sessionId: string;
      getState: () => Record<string, unknown>;
    };
  }
}
