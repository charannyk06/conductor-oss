/**
 * Fetch/API wrappers for terminal operations:
 * connection info, snapshot fetch, resize POST, input POST, session status, etc.
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
        transport?: string;
        wsUrl?: string | null;
        ptyWsUrl?: string | null;
        interactive?: boolean;
        fallbackReason?: string | null;
        stream?: {
          transport?: string;
          wsUrl?: string | null;
        } | null;
        control?: {
          transport?: "http";
          interactive?: boolean;
          fallbackReason?: string | null;
        } | null;
        error?: string;
      }
    | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal connection: ${response.status}`);
  }
  const rawStreamWsUrl = data?.stream?.wsUrl;
  const rawStreamTransport = data?.stream?.transport ?? data?.transport;
  if (typeof rawStreamTransport === "string" && rawStreamTransport !== "eventstream") {
    throw new Error(`Unsupported terminal transport: ${rawStreamTransport}`);
  }
  const interactive = data?.control?.interactive === true || data?.interactive === true;
  const fallbackReason = typeof data?.control?.fallbackReason === "string" && data.control.fallbackReason.trim().length > 0
    ? data.control.fallbackReason.trim()
    : (typeof data?.fallbackReason === "string" && data.fallbackReason.trim().length > 0
      ? data.fallbackReason.trim()
      : null);

  const streamWsUrl = typeof rawStreamWsUrl === "string" && rawStreamWsUrl.trim().length > 0
    ? rawStreamWsUrl.trim()
    : (typeof data?.wsUrl === "string" && data.wsUrl.trim().length > 0 ? data.wsUrl.trim() : null);

  if (streamWsUrl === null) {
    throw new Error("Terminal connection did not include a live stream URL");
  }

  const connection: TerminalConnectionInfo = {
    ptyWsUrl:
      typeof data?.ptyWsUrl === "string" && data.ptyWsUrl.trim().length > 0
        ? data.ptyWsUrl.trim()
        : null,
    stream: {
      transport: "eventstream",
      wsUrl: streamWsUrl,
    },
    control: {
      transport: "http",
      interactive,
      fallbackReason,
    },
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
    // Keep only one readable payload in the browser for archived/read-only sessions.
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

export async function postSessionTerminalKeys(
  sessionId: string,
  body: { keys?: string; special?: string },
): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to send terminal input: ${response.status}`);
  }
}

export async function postTerminalResize(sessionId: string, cols: number, rows: number): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/resize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cols: Math.max(1, Math.round(cols)),
      rows: Math.max(1, Math.round(rows)),
    }),
  });
  if (response.status === 404) {
    // Older backends do not expose the resize endpoint yet. Keep remote terminals usable.
    return;
  }
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resize terminal: ${response.status}`);
  }
}
