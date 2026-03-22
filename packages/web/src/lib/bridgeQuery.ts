import { decodeBridgeSessionId, normalizeBridgeId } from "@/lib/bridgeSessionIds";

export function withBridgeQuery(pathname: string, bridgeId?: string | null): string {
  const normalizedBridgeId = normalizeBridgeId(bridgeId);
  if (!normalizedBridgeId) {
    return pathname;
  }

  const url = new URL(pathname, "http://127.0.0.1");
  url.searchParams.set("bridgeId", normalizedBridgeId);
  return `${url.pathname}${url.search}${url.hash}`;
}

function asUrl(value: string | URL | Location | null | undefined): URL | null {
  if (!value) {
    return null;
  }

  if (value instanceof URL) {
    return value;
  }

  if (typeof value === "string") {
    try {
      return new URL(value, "http://127.0.0.1");
    } catch {
      return null;
    }
  }

  if (typeof value.href === "string") {
    try {
      return new URL(value.href);
    } catch {
      return null;
    }
  }

  return null;
}

export function resolveBridgeIdFromLocation(
  value: string | URL | Location | null | undefined,
): string | null {
  const url = asUrl(value);
  if (!url) {
    return null;
  }

  const explicitBridgeId = normalizeBridgeId(
    url.searchParams.get("bridge") ?? url.searchParams.get("bridgeId"),
  );
  if (explicitBridgeId) {
    return explicitBridgeId;
  }

  const selectedSessionBridgeId = decodeBridgeSessionId(url.searchParams.get("session"))?.bridgeId;
  if (selectedSessionBridgeId) {
    return selectedSessionBridgeId;
  }

  const sessionPathMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  if (!sessionPathMatch) {
    return null;
  }

  try {
    return decodeBridgeSessionId(decodeURIComponent(sessionPathMatch[1]))?.bridgeId ?? null;
  } catch {
    return null;
  }
}
