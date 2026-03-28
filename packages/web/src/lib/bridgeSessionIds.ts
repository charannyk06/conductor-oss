import type { DashboardSession } from "@/lib/types";

const REMOTE_SESSION_PREFIX = "bridge:";

export type BridgeSessionRef = {
  bridgeId: string;
  sessionId: string;
};

export function normalizeBridgeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function encodeBridgeSessionId(bridgeId: string, sessionId: string): string {
  return `${REMOTE_SESSION_PREFIX}${bridgeId}:${sessionId}`;
}

export function decodeBridgeSessionId(value: string | null | undefined): BridgeSessionRef | null {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith(REMOTE_SESSION_PREFIX)) {
    return null;
  }

  const remainder = trimmed.slice(REMOTE_SESSION_PREFIX.length);
  const delimiterIndex = remainder.indexOf(":");
  if (delimiterIndex <= 0 || delimiterIndex >= remainder.length - 1) {
    return null;
  }

  const bridgeId = normalizeBridgeId(remainder.slice(0, delimiterIndex));
  const sessionId = remainder.slice(delimiterIndex + 1).trim();
  if (!bridgeId || sessionId.length === 0) {
    return null;
  }

  return { bridgeId, sessionId };
}

export function getDisplaySessionId(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  return decodeBridgeSessionId(trimmed)?.sessionId ?? trimmed;
}

function looksLikeDashboardSession(value: unknown): value is DashboardSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "string" && typeof candidate["projectId"] === "string";
}

export function decorateBridgeSession<T extends DashboardSession>(
  session: T,
  bridgeId: string,
): T {
  return {
    ...session,
    id: encodeBridgeSessionId(bridgeId, session.id),
    bridgeId,
    bridgeConnected: true,
  };
}

export function mapBridgeSessionPayload(payload: unknown, bridgeId: string): unknown {
  if (Array.isArray(payload)) {
    return payload.map((entry) => (looksLikeDashboardSession(entry) ? decorateBridgeSession(entry, bridgeId) : entry));
  }

  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if (looksLikeDashboardSession(payload)) {
    return decorateBridgeSession(payload, bridgeId);
  }

  const candidate = payload as Record<string, unknown>;
  const mapped = { ...candidate };

  if (Array.isArray(candidate["sessions"])) {
    mapped["sessions"] = candidate["sessions"].map((entry) => (
      looksLikeDashboardSession(entry) ? decorateBridgeSession(entry, bridgeId) : entry
    ));
  }

  if (looksLikeDashboardSession(candidate["session"])) {
    mapped["session"] = decorateBridgeSession(candidate["session"], bridgeId);
  }

  return mapped;
}
