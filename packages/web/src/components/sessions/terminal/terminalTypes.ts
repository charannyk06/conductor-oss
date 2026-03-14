/**
 * Interfaces, type aliases, and enums used by the terminal subsystem.
 */

import type { TerminalViewportState } from "../terminalViewport";
import type { TerminalHttpControlOperation } from "../sessionTerminalUtils";
import type { TerminalInsertRequest } from "../terminalInsert";

export type { TerminalModeState } from "../sessionTerminalUtils";
export type { TerminalViewportState } from "../terminalViewport";
export type { TerminalInsertRequest } from "../terminalInsert";
export type { TerminalHttpControlOperation } from "../sessionTerminalUtils";

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
  stream: {
    transport: "eventstream";
    wsUrl: string | null;
  };
  control: {
    transport: "http";
    interactive: boolean;
    fallbackReason: string | null;
  };
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

export type TerminalServerEvent =
  | {
      type: "control";
      event: "ready" | "ack" | "pong" | "exit";
      sessionId: string;
      action?: string;
      exitCode?: number;
    }
  | {
      type: "recovery";
      sessionId: string;
      reason: "lagged";
      skipped: number;
      sequence: number;
      snapshotVersion: number;
      cols: number;
      rows: number;
      modes?: TerminalSnapshot["modes"];
    }
  | { type: "error"; sessionId: string; error: string };

export type TerminalStreamEventMessage =
  | TerminalServerEvent
  | {
      type: "restore";
      sessionId: string;
      sequence: number;
      snapshotVersion: number;
      reason: "attach" | "lagged" | "unknown";
      cols: number;
      rows: number;
      modes?: TerminalSnapshot["modes"];
      payload: string;
    }
  | {
      type: "stream";
      sessionId: string;
      sequence: number;
      payload: string;
    };

export type PreferredFocusTarget = "none" | "terminal" | "resume";

export type PendingTerminalHttpControlOperation = TerminalHttpControlOperation & {
  reject: (error: unknown) => void;
  resolve: () => void;
};

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
