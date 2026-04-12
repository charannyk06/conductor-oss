/**
 * Terminal API utilities.
 * Authentication still flows through the Next.js proxy. Interactive terminals
 * render through a backend-hosted ttyd facade so the browser stays attached
 * to one persistent terminal session instead of opening a fresh ttyd client.
 */

import type { TerminalConnectionInfo } from "./terminalTypes";
import { withBridgeQuery } from "@/lib/bridgeQuery";

// ---------------------------------------------------------------------------
// Direct backend URL resolution — no server round-trip
// ---------------------------------------------------------------------------

/**
 * Resolve the Rust backend origin from the browser.
 *
 * Priority:
 *  1. The runtime meta tag published by the root layout
 *  2. `NEXT_PUBLIC_CONDUCTOR_BACKEND_URL` (build-time env var)
 *  3. Dev heuristics for known local dashboard ports
 *  4. Same origin as a final fallback when no backend hint exists
 */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function readBackendOriginFromMeta(): string | null {
  if (typeof document === "undefined") return null;

  const meta = document.querySelector<HTMLMetaElement>('meta[name="conductor-backend-url"]');
  const content = meta?.content?.trim();
  if (!content) return null;

  try {
    const base = typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin;
    const url = new URL(content, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    if (typeof window !== "undefined") {
      const current = new URL(window.location.origin);
      if (isLoopbackHostname(url.hostname) && !isLoopbackHostname(current.hostname)) {
        url.hostname = current.hostname;
        if (current.protocol === "https:" && url.protocol === "http:") {
          url.protocol = "https:";
        }
      }
    }

    return url.toString();
  } catch {
    return null;
  }
}

function normalizeTerminalPathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname;
}

function resolveDashboardOrigin(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:3000";
  return window.location.origin;
}

function isDashboardTtydProxyPath(pathname: string): boolean {
  return pathname.startsWith("/api/sessions/") && pathname.includes("/terminal/ttyd");
}

function resolveBackendOrigin(): string {
  const runtimeBackendUrl = readBackendOriginFromMeta();
  if (runtimeBackendUrl) return runtimeBackendUrl;

  const envUrl = process.env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL?.trim();
  if (envUrl) return envUrl;

  if (typeof window === "undefined") return "http://127.0.0.1:4749";

  const { protocol, hostname, origin, port } = window.location;
  if (port === "3000" || port === "4747") {
    return `${protocol}//${hostname}:4749`;
  }

  return origin;
}

type TerminalTokenResult =
  | {
    interactive: true;
    ttydHttpUrl: string | null;
    ttydWsUrl: string | null;
    tunnelUrl: string | null;
    relayTtydWsUrl: string | null;
    expiresInSeconds: number | null;
  }
  | {
    interactive: false;
    ttydHttpUrl: null;
    ttydWsUrl: null;
    tunnelUrl: null;
    relayTtydWsUrl: null;
    reason: string | null;
  };

function resolveProvidedTtydHttpUrl(
  ttydHttpUrl: string | null,
  ttydWsUrl: string | null,
  backendOrigin: string,
  dashboardOrigin: string,
): string | null {
  const candidate = ttydHttpUrl ?? ttydWsUrl;
  if (!candidate) return null;
  try {
    const candidatePathname = (() => {
      try {
        return new URL(candidate, dashboardOrigin).pathname;
      } catch {
        return null;
      }
    })();
    const baseOrigin = candidatePathname && isDashboardTtydProxyPath(candidatePathname)
      ? dashboardOrigin
      : backendOrigin;
    const resolved = new URL(candidate, baseOrigin);

    if (resolved.protocol === "ws:") resolved.protocol = "http:";
    if (resolved.protocol === "wss:") resolved.protocol = "https:";
    if (resolved.pathname === "/ws") {
      resolved.pathname = "/";
    } else if (resolved.pathname.endsWith("/ws")) {
      resolved.pathname = normalizeTerminalPathname(resolved.pathname.slice(0, -3));
    }
    resolved.pathname = normalizeTerminalPathname(resolved.pathname);
    resolved.hash = "";

    return resolved.toString();
  } catch {
    return null;
  }
}

function appendBridgeIdToTerminalUrl(
  terminalUrl: string,
  bridgeId?: string | null,
): string {
  const normalizedBridgeId = bridgeId?.trim();
  if (!normalizedBridgeId) {
    return terminalUrl;
  }

  try {
    const resolved = new URL(terminalUrl);
    if (!isDashboardTtydProxyPath(resolved.pathname)) {
      return terminalUrl;
    }

    resolved.searchParams.set("bridgeId", normalizedBridgeId);
    return resolved.toString();
  } catch {
    return terminalUrl;
  }
}

function buildEmbeddedTerminalUrl(
  sessionId: string,
  dashboardOrigin: string,
  bridgeId?: string | null,
): string {
  const url = new URL(`/embed/terminal/${encodeURIComponent(sessionId)}`, dashboardOrigin);
  const normalizedBridgeId = bridgeId?.trim();
  if (normalizedBridgeId) {
    url.searchParams.set("bridgeId", normalizedBridgeId);
  }
  return url.toString();
}

type ResolveTerminalConnectionOptions = {
  bridgeId?: string | null;
  signal?: AbortSignal;
};

async function fetchTerminalToken(
  sessionId: string,
  options?: ResolveTerminalConnectionOptions,
): Promise<TerminalTokenResult> {
  const res = await fetch(
    withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/token`, options?.bridgeId),
    {
      cache: "no-store",
      credentials: "same-origin",
      signal: options?.signal,
    },
  );
  const data = (await res.json().catch(() => null)) as
    | {
      required?: boolean;
      ttydHttpUrl?: string;
      ttydWsUrl?: string;
      tunnelUrl?: string;
      relayTtydWsUrl?: string;
      expiresInSeconds?: number | string | null;
      error?: string;
    }
    | null;
  const ttydHttpUrl =
    typeof data?.ttydHttpUrl === "string" && data.ttydHttpUrl.trim().length > 0
      ? data.ttydHttpUrl.trim()
      : null;
  const ttydWsUrl =
    typeof data?.ttydWsUrl === "string" && data.ttydWsUrl.trim().length > 0
      ? data.ttydWsUrl.trim()
      : null;
  const tunnelUrl =
    typeof data?.tunnelUrl === "string" && data.tunnelUrl.trim().length > 0
      ? data.tunnelUrl.trim()
      : null;
  const relayTtydWsUrl =
    typeof data?.relayTtydWsUrl === "string" && data.relayTtydWsUrl.trim().length > 0
      ? data.relayTtydWsUrl.trim()
      : null;
  const expiresInSeconds = (() => {
    const raw = data?.expiresInSeconds;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.max(0, Math.floor(raw));
    }
    if (typeof raw === "string") {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
    return null;
  })();

  if (res.status === 401 || res.status === 403) {
    return {
      interactive: false,
      ttydHttpUrl: null,
      ttydWsUrl: null,
      tunnelUrl: null,
      relayTtydWsUrl: null,
      reason: data?.error ?? "Terminal access denied",
    };
  }

  if (!res.ok) {
    return {
      interactive: false,
      ttydHttpUrl: null,
      ttydWsUrl: null,
      tunnelUrl: null,
      relayTtydWsUrl: null,
      reason: data?.error ?? "Terminal unavailable",
    };
  }

  return {
    interactive: true,
    ttydHttpUrl,
    ttydWsUrl,
    tunnelUrl,
    relayTtydWsUrl,
    expiresInSeconds,
  };
}

function extractResolvedTerminalToken(terminalUrl: string | null): string | null {
  if (!terminalUrl) {
    return null;
  }

  try {
    return new URL(terminalUrl).searchParams.get("token");
  } catch {
    return null;
  }
}

function buildDirectTerminalLinkUrl(
  embeddedTerminalUrl: string,
  auth: Extract<TerminalTokenResult, { interactive: true }>,
  bridgeId?: string | null,
): string {
  if (bridgeId?.trim() || !auth.tunnelUrl) {
    return embeddedTerminalUrl;
  }

  try {
    const directUrl = new URL(auth.tunnelUrl);
    const token = extractResolvedTerminalToken(embeddedTerminalUrl);
    if (!token) {
      return embeddedTerminalUrl;
    }
    directUrl.searchParams.set("token", token);
    return directUrl.toString();
  } catch {
    return embeddedTerminalUrl;
  }
}

export async function resolveTerminalConnection(
  sessionId: string,
  options?: ResolveTerminalConnectionOptions,
): Promise<TerminalConnectionInfo> {
  const backendOrigin = resolveBackendOrigin();
  const dashboardOrigin = resolveDashboardOrigin();
  const auth = await fetchTerminalToken(sessionId, options);
  if (auth.interactive === false) {
    return {
      terminalUrl: null,
      terminalLinkUrl: null,
      relayTtydWsUrl: null,
      interactive: false,
      reason: auth.reason,
      expiresInSeconds: null,
      tunnelUrl: null,
    };
  }

  // Keep the embedded iframe on the shimmed proxy path so auth sync, resize
  // coordination, touch, and lifecycle hardening always stay in play. Tunnel
  // URLs are exposed only as direct-open links for non-bridge sessions.
  const resolvedTerminalUrl = resolveProvidedTtydHttpUrl(
    auth.ttydHttpUrl,
    auth.ttydWsUrl,
    backendOrigin,
    dashboardOrigin,
  );

  // Frontend-only iframe path: when the backend exposes only the native terminal
  // websocket contract, render the existing iframe page instead of trying to open a
  // ttyd HTML route that does not exist on the current backend.
  if (!auth.ttydHttpUrl && auth.ttydWsUrl) {
    const embeddedTerminalUrl = buildEmbeddedTerminalUrl(
      sessionId,
      dashboardOrigin,
      options?.bridgeId,
    );
    return {
      terminalUrl: embeddedTerminalUrl,
      terminalLinkUrl: embeddedTerminalUrl,
      relayTtydWsUrl: auth.relayTtydWsUrl,
      interactive: true,
      reason: null,
      expiresInSeconds: auth.expiresInSeconds,
      tunnelUrl: auth.tunnelUrl,
    };
  }

  if (!resolvedTerminalUrl) {
    return {
      terminalUrl: null,
      terminalLinkUrl: null,
      relayTtydWsUrl: null,
      interactive: false,
      reason: "Failed to resolve the ttyd terminal URL.",
    };
  }

  const embeddedTerminalUrl = appendBridgeIdToTerminalUrl(resolvedTerminalUrl, options?.bridgeId);
  const terminalLinkUrl = buildDirectTerminalLinkUrl(embeddedTerminalUrl, auth, options?.bridgeId);

  return {
    terminalUrl: embeddedTerminalUrl,
    terminalLinkUrl,
    relayTtydWsUrl: auth.relayTtydWsUrl,
    interactive: true,
    reason: null,
    expiresInSeconds: auth.expiresInSeconds,
    tunnelUrl: auth.tunnelUrl,
  };
}
