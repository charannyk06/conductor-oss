/**
 * Interfaces and type aliases for the live session terminal.
 *
 * The supported dashboard implementation is now a first-party xterm.js page
 * rendered inside an iframe.
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
  panelVisible?: boolean;
  onPendingInsertConsumed?: () => void;
}

export type TerminalConnectionInfo = {
  interactive: boolean;
  reason: string | null;
  token?: string | null;
  required?: boolean;
  expiresInSeconds?: number | null;
  wsUrl?: string | null;
  snapshotUrl?: string | null;
  outputUrl?: string | null;
  terminalUrl?: string | null;
  terminalLinkUrl?: string | null;
  relayTtydWsUrl?: string | null;
  tunnelUrl?: string | null;
};
