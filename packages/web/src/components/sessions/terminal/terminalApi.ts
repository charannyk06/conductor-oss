/**
 * Fetch/API wrappers for terminal operations:
 * connection info and snapshot fetch. All I/O goes through TTyD WebSocket.
 */

import {
  readCachedTerminalConnection,
  storeCachedTerminalConnection,
} from "./terminalCache";
import type {
  TerminalConnectionInfo,
  TerminalSnapshot,
} from "./terminalTypes";
import type { TerminalModeState } from "../sessionTerminalUtils";

export function parseTerminalModes(value: unknown): TerminalModeState | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const mouseProtocolMode = typeof candidate["mouseProtocolMode"] === "string"
    ? candidate["mouseProtocolMode"]
    : "None";
  const mouseProtocolEncoding = typeof candidate["mouseProtocolEncoding"] === "string"
    ? candidate["mouseProtocolEncoding"]
    : "Default";

  return {
    alternateScreen: candidate["alternateScreen"] === true,
    applicationKeypad: candidate["applicationKeypad"] === true,
    applicationCursor: candidate["applicationCursor"] === true,
    hideCursor: candidate["hideCursor"] === true,
    bracketedPaste: candidate["bracketedPaste"] === true,
    mouseProtocolMode,
    mouseProtocolEncoding,
  };
}

export async function fetchTerminalConnection(sessionId: string): Promise<TerminalConnectionInfo> {
  const cached = readCachedTerminalConnection(sessionId);
  if (cached) {
    return cached;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/connection`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | {
        ptyWsUrl?: string | null;
        interactive?: boolean;
        error?: string;
      }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal connection: ${response.status}`);
  }

  const connection: TerminalConnectionInfo = {
    ptyWsUrl:
      typeof data?.ptyWsUrl === "string" && data.ptyWsUrl.trim().length > 0
        ? data.ptyWsUrl.trim()
        : null,
    interactive: data?.interactive === true,
  };
  storeCachedTerminalConnection(sessionId, connection);
  return connection;
}

export async function fetchTerminalSnapshot(sessionId: string, lines: number): Promise<TerminalSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/snapshot?lines=${lines}`, {
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as
    | { snapshot?: string; transcript?: string; source?: string; live?: boolean; restored?: boolean; sequence?: number; modes?: unknown; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal snapshot: ${response.status}`);
  }
  const rawSnapshot = typeof data?.snapshot === "string" ? data.snapshot : "";
  const transcript = typeof data?.transcript === "string" ? data.transcript : "";
  const compactedSnapshot = transcript.trim().length > 0 ? transcript : rawSnapshot;
  return {
    snapshot: compactedSnapshot,
    transcript: "",
    source: typeof data?.source === "string" ? data.source : "empty",
    live: data?.live === true,
    restored: data?.restored === true,
    sequence: typeof data?.sequence === "number" && Number.isSafeInteger(data.sequence)
      ? data.sequence
      : null,
    modes: parseTerminalModes(data?.modes),
  };
}

export async function fetchSessionStatus(sessionId: string): Promise<string | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to load session: ${response.status}`);
  }

  const data = (await response.json().catch(() => null)) as { status?: unknown } | null;
  return typeof data?.status === "string" && data.status.trim().length > 0
    ? data.status.trim()
    : null;
}
