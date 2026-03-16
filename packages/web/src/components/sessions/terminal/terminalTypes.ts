/**
 * Interfaces, type aliases, and enums used by the terminal subsystem.
 */

import type { TerminalViewportState } from "../terminalViewport";

export type TerminalConnectionPath =
  | "direct"
  | "managed_remote"
  | "dashboard_proxy"
  | "auth_limited"
  | "unavailable";

export type TerminalConnectionInfo = {
  stream: {
    transport: "websocket" | "eventstream";
    wsUrl: string | null;
    pollIntervalMs: number;
    fallbackUrl: string | null;
  };
  control: {
    transport: "websocket" | "http";
    wsUrl: string | null;
    interactive: boolean;
    requiresToken: boolean;
    tokenExpiresInSeconds: number | null;
    fallbackReason: string | null;
    sendPath: string;
    keysPath: string;
    resizePath: string;
  };
  connectionPath: TerminalConnectionPath;
  /** Direct WebSocket URL to an external ttyd process.  When present the
   *  frontend should prefer this over the Conductor stream URL. */
  ttydWsUrl: string | null;
  /** HTTP URL of the external ttyd process. */
  ttydHttpUrl: string | null;
};

export type TerminalRuntimeAuthority = "daemon" | "detached_host" | "session_metadata";

export type TerminalRuntimeStatus =
  | "ready"
  | "spawning"
  | "exited"
  | "failed"
  | "missing"
  | "unknown";

export type TerminalRuntimeInfo = {
  authority: TerminalRuntimeAuthority;
  status: TerminalRuntimeStatus;
  daemonConnected: boolean | null;
  hostPid: number | null;
  childPid: number | null;
  cols: number | null;
  rows: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  error: string | null;
  notice: string | null;
  recoveryAction: string | null;
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
      event: "ready" | "ack" | "pong" | "exit" | "input_queue_full";
      sessionId: string;
      action?: string;
      exitCode?: number;
      queueFull?: boolean;
      status?: "queue_full";
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

export type CachedTerminalConnection = {
  value: TerminalConnectionInfo;
  expiresAt: number;
};

export type CachedTerminalSnapshot = TerminalSnapshot & {
  updatedAt: number;
};

export type CachedTerminalUiState = {
  searchOpen: boolean;
  searchQuery: string;
  viewport: TerminalViewportState | null;
  updatedAt: number;
};

export type TerminalCoreClientModules = [
  typeof import("@xterm/xterm"),
  typeof import("@xterm/addon-fit"),
];

/** Parsed ttyd server message. */
export type TtydServerMessage =
  | { type: "output"; payload: Uint8Array }
  | { type: "title"; title: string }
  | { type: "prefs"; prefs: Record<string, unknown> };
