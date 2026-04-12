/**
 * Interfaces and type aliases for the live session terminal.
 *
 * The supported dashboard implementation stays iframe-based through
 * `SessionTerminal`, which can load either the ttyd facade path or the
 * embedded terminal page depending on what the backend exposes.
 */

import type { TerminalInsertRequest } from "../terminalInsert";

export interface SessionTerminalProps {
  sessionId: string;
  projectId: string;
  bridgeId?: string | null;
  sessionState: string;
  runtimeMode?: string | null;
  pendingInsert: TerminalInsertRequest | null;
  immersiveMobileMode?: boolean;
  /**
   * When false, the terminal panel is not visible (e.g. another session tab is active).
   * Skips resize spam and clears cached host size so refit runs when the tab returns.
   */
  panelVisible?: boolean;
  /** Called after the terminal consumes a pending insert so the parent can clear it. */
  onPendingInsertConsumed?: () => void;
}

export type TerminalConnectionInfo = {
  terminalUrl: string | null;
  terminalLinkUrl?: string | null;
  relayTtydWsUrl?: string | null;
  interactive: boolean;
  reason: string | null;
  expiresInSeconds?: number | null;
  tunnelUrl?: string | null;
};

declare global {
  interface Window {
    __conductorSessionTerminalDebug?: {
      sessionId: string;
      getState: () => Record<string, unknown>;
    };
    __conductorDispatcherDebug?: {
      sessionId: string;
      getState: () => Record<string, unknown>;
    };
    __conductorSessionPreviewDebug?: {
      sessionId: string;
      getState: () => Record<string, unknown>;
    };
  }
}
