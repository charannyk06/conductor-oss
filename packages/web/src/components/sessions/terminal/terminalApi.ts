/**
 * Fetch/API wrappers for terminal operations:
 * connection info, bootstrap fetch, snapshot fetch, resize POST, input POST,
 * and session status.
 */

import {
  readCachedTerminalConnection,
  storeCachedTerminalConnection,
} from "./terminalCache";
import type {
  TerminalConnectionInfo,
  TerminalConnectionPath,
  TerminalRuntimeInfo,
  TerminalSnapshot,
} from "./terminalTypes";
import type { TerminalModeState } from "../sessionTerminalUtils";

const DEFAULT_REMOTE_POLL_INTERVAL_MS = 700;
const TERMINAL_CONNECTION_CACHE_SAFETY_WINDOW_MS = 5_000;

type TerminalConnectionResponsePayload = {
  connectionPath?: TerminalConnectionPath;
  stream?: {
    transport?: "websocket" | "eventstream";
    wsUrl?: string | null;
    pollIntervalMs?: number;
    fallbackUrl?: string | null;
  } | null;
  control?: {
    transport?: "websocket" | "http";
    wsUrl?: string | null;
    interactive?: boolean;
    requiresToken?: boolean;
    tokenExpiresInSeconds?: number | null;
    fallbackReason?: string | null;
    sendPath?: string | null;
    keysPath?: string | null;
    resizePath?: string | null;
  } | null;
  /** Direct WebSocket URL to an external ttyd process. */
  ttydWsUrl?: string | null;
  /** HTTP URL of the external ttyd process. */
  ttydHttpUrl?: string | null;
  error?: string;
};

type TerminalRuntimeResponsePayload = {
  authority?: string | null;
  status?: string | null;
  daemonConnected?: boolean | null;
  hostPid?: number | null;
  childPid?: number | null;
  cols?: number | null;
  rows?: number | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  error?: string | null;
  notice?: string | null;
  recoveryAction?: string | null;
};

type TerminalSnapshotResponsePayload = {
  snapshot?: string;
  snapshotAnsi?: string;
  transcript?: string;
  source?: string;
  live?: boolean;
  restored?: boolean;
  sequence?: number;
  modes?: unknown;
  error?: string;
};

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

function parseTerminalConnectionPath(value: string | null | undefined): TerminalConnectionPath {
  switch (value) {
    case "direct":
    case "managed_remote":
    case "dashboard_proxy":
    case "auth_limited":
    case "unavailable":
      return value;
    default:
      return "unavailable";
  }
}

function defaultTerminalControlPaths(sessionId: string): {
  sendPath: string;
  keysPath: string;
  resizePath: string;
} {
  const encodedSessionId = encodeURIComponent(sessionId);
  return {
    sendPath: `/api/sessions/${encodedSessionId}/send`,
    keysPath: `/api/sessions/${encodedSessionId}/keys`,
    resizePath: `/api/sessions/${encodedSessionId}/terminal/resize`,
  };
}

function defaultTerminalStreamFallbackUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/terminal/stream`;
}

function normalizeControlPath(value: string | null | undefined, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function calculateTerminalConnectionCacheTtlMs(connection: TerminalConnectionInfo): number | undefined {
  const tokenExpiresInSeconds = connection.control.tokenExpiresInSeconds;
  if (typeof tokenExpiresInSeconds !== "number" || !Number.isFinite(tokenExpiresInSeconds)) {
    return undefined;
  }

  return Math.max(
    1_000,
    Math.round(tokenExpiresInSeconds * 1000) - TERMINAL_CONNECTION_CACHE_SAFETY_WINDOW_MS,
  );
}

function isAllowedWebSocketOrigin(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== "undefined" ? window.location.href : undefined);
    const hostname = parsed.hostname;
    // Allow loopback addresses (local-first architecture)
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
    // Allow same hostname as the current page (covers different ports)
    if (typeof window !== "undefined" && hostname === window.location.hostname) return true;
    return false;
  } catch {
    return false;
  }
}

function normalizeTerminalConnectionInfo(
  sessionId: string,
  response: Response,
  data: TerminalConnectionResponsePayload | null,
): TerminalConnectionInfo {
  const streamTransport = data?.stream?.transport === "eventstream" ? "eventstream" : "websocket";
  const rawPollMs = data?.stream?.pollIntervalMs;
  const pollIntervalMs =
    typeof rawPollMs === "number" && Number.isFinite(rawPollMs) && rawPollMs >= 100
      ? Math.round(rawPollMs)
      : DEFAULT_REMOTE_POLL_INTERVAL_MS;
  const controlTransport = data?.control?.transport === "http" ? "http" : "websocket";
  const interactive = data?.control?.interactive === true;
  const requiresToken = data?.control?.requiresToken === true;
  const rawTokenExpires = data?.control?.tokenExpiresInSeconds;
  const tokenExpiresInSeconds =
    typeof rawTokenExpires === "number" && Number.isFinite(rawTokenExpires)
      ? Math.round(rawTokenExpires)
      : null;
  const rawFallbackReason = data?.control?.fallbackReason;
  const fallbackReason =
    typeof rawFallbackReason === "string" && rawFallbackReason.trim().length > 0
      ? rawFallbackReason.trim()
      : null;

  const rawStreamWsUrl = data?.stream?.wsUrl;
  const streamWsUrl =
    typeof rawStreamWsUrl === "string" && rawStreamWsUrl.trim().length > 0
      ? rawStreamWsUrl.trim()
      : null;
  const rawControlWsUrl = data?.control?.wsUrl;
  const controlWsUrl =
    typeof rawControlWsUrl === "string" && rawControlWsUrl.trim().length > 0
      ? rawControlWsUrl.trim()
      : null;

  if (streamWsUrl === null) {
    throw new Error("Terminal connection did not include a live stream URL");
  }
  if (controlTransport === "websocket" && interactive && controlWsUrl === null) {
    throw new Error("Terminal connection did not include a control websocket URL");
  }

  // Validate WebSocket origins to prevent connecting to attacker-controlled servers.
  // managed_remote connections explicitly trust the backend's URL construction.
  const connectionPath = parseTerminalConnectionPath(
    data?.connectionPath ?? response.headers.get("x-conductor-terminal-connection-path"),
  );
  if (connectionPath !== "managed_remote") {
    if (streamWsUrl && !isAllowedWebSocketOrigin(streamWsUrl)) {
      console.warn("[terminal] Rejected stream WebSocket URL with untrusted origin:", streamWsUrl);
      throw new Error("Terminal stream URL has an untrusted origin");
    }
    if (controlWsUrl && !isAllowedWebSocketOrigin(controlWsUrl)) {
      console.warn("[terminal] Rejected control WebSocket URL with untrusted origin:", controlWsUrl);
      throw new Error("Terminal control URL has an untrusted origin");
    }
  }

  const defaultControlPaths = defaultTerminalControlPaths(sessionId);

  const rawTtydWsUrl = data?.ttydWsUrl;
  const ttydWsUrl =
    typeof rawTtydWsUrl === "string" && rawTtydWsUrl.trim().length > 0
      ? rawTtydWsUrl.trim()
      : null;
  const rawTtydHttpUrl = data?.ttydHttpUrl;
  const ttydHttpUrl =
    typeof rawTtydHttpUrl === "string" && rawTtydHttpUrl.trim().length > 0
      ? rawTtydHttpUrl.trim()
      : null;

  return {
    connectionPath,
    stream: {
      transport: streamTransport,
      wsUrl: streamWsUrl,
      pollIntervalMs,
      fallbackUrl: normalizeControlPath(
        data?.stream?.fallbackUrl,
        defaultTerminalStreamFallbackUrl(sessionId),
      ),
    },
    control: {
      transport: controlTransport,
      wsUrl: controlWsUrl,
      interactive,
      requiresToken,
      tokenExpiresInSeconds,
      fallbackReason,
      sendPath: normalizeControlPath(data?.control?.sendPath, defaultControlPaths.sendPath),
      keysPath: normalizeControlPath(data?.control?.keysPath, defaultControlPaths.keysPath),
      resizePath: normalizeControlPath(data?.control?.resizePath, defaultControlPaths.resizePath),
    },
    ttydWsUrl,
    ttydHttpUrl,
  };
}

function normalizeTerminalRuntimeInfo(data: TerminalRuntimeResponsePayload | null): TerminalRuntimeInfo | null {
  if (!data) {
    return null;
  }

  const authority = (() => {
    switch (data.authority) {
      case "daemon":
      case "detached_host":
      case "session_metadata":
        return data.authority;
      default:
        return "session_metadata";
    }
  })();

  const status = (() => {
    switch (data.status) {
      case "ready":
      case "spawning":
      case "exited":
      case "failed":
      case "missing":
      case "unknown":
        return data.status;
      default:
        return "unknown";
    }
  })();

  return {
    authority,
    status,
    daemonConnected: typeof data.daemonConnected === "boolean" ? data.daemonConnected : null,
    hostPid: typeof data.hostPid === "number" && Number.isFinite(data.hostPid)
      ? Math.round(data.hostPid)
      : null,
    childPid: typeof data.childPid === "number" && Number.isFinite(data.childPid)
      ? Math.round(data.childPid)
      : null,
    cols: typeof data.cols === "number" && Number.isFinite(data.cols)
      ? Math.round(data.cols)
      : null,
    rows: typeof data.rows === "number" && Number.isFinite(data.rows)
      ? Math.round(data.rows)
      : null,
    startedAt: typeof data.startedAt === "string" && data.startedAt.trim().length > 0
      ? data.startedAt
      : null,
    updatedAt: typeof data.updatedAt === "string" && data.updatedAt.trim().length > 0
      ? data.updatedAt
      : null,
    error: typeof data.error === "string" && data.error.trim().length > 0 ? data.error : null,
    notice: typeof data.notice === "string" && data.notice.trim().length > 0 ? data.notice : null,
    recoveryAction: typeof data.recoveryAction === "string" && data.recoveryAction.trim().length > 0
      ? data.recoveryAction
      : null,
  };
}

function normalizeTerminalSnapshot(
  response: Response,
  data: TerminalSnapshotResponsePayload | null,
): TerminalSnapshot {
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal snapshot: ${response.status}`);
  }

  const modes = parseTerminalModes(data?.modes);
  const rawSnapshot = typeof data?.snapshot === "string"
    ? data.snapshot
    : typeof data?.snapshotAnsi === "string"
      ? data.snapshotAnsi
      : "";
  const transcript = typeof data?.transcript === "string" ? data.transcript : "";
  const compactedSnapshot = transcript.trim().length > 0 && modes?.alternateScreen !== true
    ? transcript
    : rawSnapshot;

  return {
    snapshot: compactedSnapshot,
    transcript,
    source: typeof data?.source === "string" ? data.source : "empty",
    live: data?.live === true,
    restored: data?.restored === true,
    sequence: typeof data?.sequence === "number" && Number.isSafeInteger(data.sequence)
      ? data.sequence
      : null,
    modes,
  };
}

export async function fetchTerminalSnapshot(
  sessionId: string,
  lines: number,
  options?: { live?: boolean },
): Promise<TerminalSnapshot> {
  const params = new URLSearchParams({ lines: String(lines) });
  if (options?.live) {
    params.set("live", "1");
  }

  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminal/snapshot?${params.toString()}`,
    { cache: "no-store" },
  );
  const data = (await response.json().catch(() => null)) as TerminalSnapshotResponsePayload | null;
  return normalizeTerminalSnapshot(response, data);
}

export async function fetchFastBootstrap(
  sessionId: string,
): Promise<{
  connection: TerminalConnectionInfo;
  runtime: TerminalRuntimeInfo | null;
}> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminal/fast-bootstrap`,
    { cache: "no-store" },
  );
  const data = (await response.json().catch(() => null)) as {
    connection?: TerminalConnectionResponsePayload | null;
    runtime?: TerminalRuntimeResponsePayload | null;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal fast bootstrap: ${response.status}`);
  }

  const connection = normalizeTerminalConnectionInfo(sessionId, response, data?.connection ?? null);
  storeCachedTerminalConnection(
    sessionId,
    connection,
    calculateTerminalConnectionCacheTtlMs(connection),
  );

  return {
    connection,
    runtime: normalizeTerminalRuntimeInfo(data?.runtime ?? null),
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
): Promise<{ accepted: boolean; queueFull: boolean }> {
  const connection = readCachedTerminalConnection(sessionId);
  const path = connection?.control.keysPath ?? defaultTerminalControlPaths(sessionId).keysPath;
  const response = await fetch(path, {
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
  const responseData = (data ?? {}) as {
    accepted?: unknown;
    queueFull?: unknown;
    error?: unknown;
  };
  const accepted =
    typeof responseData.accepted === "boolean"
      ? responseData.accepted
      : response.ok;
  return {
    accepted,
    queueFull:
      typeof responseData.queueFull === "boolean"
        ? responseData.queueFull
        : !accepted,
  };
}

export async function postTerminalResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const connection = readCachedTerminalConnection(sessionId);
  const path = connection?.control.resizePath ?? defaultTerminalControlPaths(sessionId).resizePath;
  const response = await fetch(path, {
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
    return;
  }
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to resize terminal: ${response.status}`);
  }
}

export type TtydSessionInfo = {
  sessionId: string;
  native: boolean;
  interactive: boolean;
  notice: string | null;
  wsUrl: string;
};

export async function spawnTtydSession(
  sessionId: string,
  options?: { cols?: number; rows?: number },
): Promise<TtydSessionInfo> {
  const params = new URLSearchParams();
  if (options?.cols) params.set("cols", String(options.cols));
  if (options?.rows) params.set("rows", String(options.rows));

  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/ttyd/spawn?${params.toString()}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Failed to spawn ttyd session: ${response.status}`);
  }

  const data = (await response.json()) as {
    session_id: string;
    native: boolean;
    interactive?: boolean;
    notice?: string | null;
  };
  // Build the native WebSocket URL from the current origin
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${window.location.host}/api/sessions/${encodeURIComponent(data.session_id)}/ttyd/ws`;
  return {
    sessionId: data.session_id,
    native: data.native,
    interactive: data.interactive !== false,
    notice: typeof data.notice === "string" && data.notice.trim().length > 0 ? data.notice : null,
    wsUrl,
  };
}

export async function killTtydSession(sessionId: string): Promise<void> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/ttyd/kill`,
    { method: "POST" },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Failed to kill ttyd session: ${response.status}`);
  }
}
