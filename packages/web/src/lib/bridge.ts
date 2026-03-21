import {
  BRIDGE_RELAY_URL_STORAGE_KEY,
  BRIDGE_TOKEN_STORAGE_KEY,
} from "@/types/bridge";

export interface BridgeSettings {
  token: string | null;
  relayUrl: string | null;
}

function readStorageValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(key)?.trim();
  return value && value.length > 0 ? value : null;
}

export function readBridgeSettings(): BridgeSettings {
  return {
    token: readStorageValue(BRIDGE_TOKEN_STORAGE_KEY),
    relayUrl: readStorageValue(BRIDGE_RELAY_URL_STORAGE_KEY),
  };
}

function normalizeRelayUrl(value: string, target: "http" | "ws"): string | null {
  try {
    const base = typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin;
    const url = new URL(value, base);
    if (target === "http") {
      if (url.protocol === "ws:") {
        url.protocol = "http:";
      } else if (url.protocol === "wss:") {
        url.protocol = "https:";
      } else if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }
    } else if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function splitPathAndQuery(path: string): { pathname: string; query: string } {
  const [pathname, query = ""] = path.split("?");
  return {
    pathname: pathname.startsWith("/") ? pathname : `/${pathname}`,
    query,
  };
}

export function buildBridgeHttpUrl(path: string): string | null {
  const { relayUrl } = readBridgeSettings();
  if (!relayUrl) return null;
  const base = normalizeRelayUrl(relayUrl, "http");
  if (!base) return null;

  const url = new URL(base);
  const { pathname, query } = splitPathAndQuery(path);
  url.pathname = pathname;
  url.search = query ? `?${query}` : "";
  return url.toString();
}

export function buildBridgeWebSocketUrl(scope: string): string | null {
  const { relayUrl, token } = readBridgeSettings();
  if (!relayUrl || !token) return null;
  const base = normalizeRelayUrl(relayUrl, "ws");
  if (!base) return null;

  const url = new URL(base);
  url.pathname = `/browser/${encodeURIComponent(scope)}`;
  url.search = `?token=${encodeURIComponent(token)}`;
  return url.toString();
}

export function hasBridgeSettings(): boolean {
  return Boolean(readStorageValue(BRIDGE_RELAY_URL_STORAGE_KEY) && readStorageValue(BRIDGE_TOKEN_STORAGE_KEY));
}

export function clearBridgeSettings(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BRIDGE_RELAY_URL_STORAGE_KEY);
  window.localStorage.removeItem(BRIDGE_TOKEN_STORAGE_KEY);
  window.dispatchEvent(new Event("storage"));
}
