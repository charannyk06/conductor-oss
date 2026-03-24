/**
 * Interfaces and type aliases used by the ttyd session terminal.
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
}

export type TerminalConnectionInfo = {
  terminalUrl: string | null;
  interactive: boolean;
  reason: string | null;
  expiresInSeconds?: number | null;
};

declare global {
  interface Window {
    __conductorSessionTerminalDebug?: {
      sessionId: string;
      getState: () => Record<string, unknown>;
    };
  }
}
