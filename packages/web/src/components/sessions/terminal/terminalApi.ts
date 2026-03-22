/**
 * Terminal API utilities.
 * Authentication still flows through the Next.js proxy. Interactive terminals
 * render through a backend-hosted ttyd facade so the browser stays attached
 * to one persistent terminal session instead of opening a fresh ttyd client.
 */

import type { TerminalConnectionInfo } from "./terminalTypes";

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
  | { interactive: true; ttydHttpUrl: string | null; ttydWsUrl: string | null }
  | { interactive: false; ttydHttpUrl: null; ttydWsUrl: null; reason: string | null };

function resolveProvidedTtydHttpUrl(
  ttydHttpUrl: string | null,
  ttydWsUrl: string | null,
  backendOrigin: string,
): string | null {
  const candidate = ttydHttpUrl ?? ttydWsUrl;
  if (!candidate) return null;
  try {
    const resolved = new URL(candidate, backendOrigin);

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

type ResolveTerminalConnectionOptions = {
  signal?: AbortSignal;
};

async function fetchTerminalToken(
  sessionId: string,
  options?: ResolveTerminalConnectionOptions,
): Promise<TerminalTokenResult> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/token`, {
    cache: "no-store",
    signal: options?.signal,
  });
  const data = (await res.json().catch(() => null)) as
    | { required?: boolean; ttydHttpUrl?: string; ttydWsUrl?: string; error?: string }
    | null;
  const ttydHttpUrl =
    typeof data?.ttydHttpUrl === "string" && data.ttydHttpUrl.trim().length > 0
      ? data.ttydHttpUrl.trim()
      : null;
  const ttydWsUrl =
    typeof data?.ttydWsUrl === "string" && data.ttydWsUrl.trim().length > 0
      ? data.ttydWsUrl.trim()
      : null;

  if (res.status === 401 || res.status === 403) {
    return {
      interactive: false,
      ttydHttpUrl: null,
      ttydWsUrl: null,
      reason: data?.error ?? "Terminal access denied",
    };
  }

  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal token: ${res.status}`);
  }

  return {
    interactive: true,
    ttydHttpUrl,
    ttydWsUrl,
  };
}

export async function resolveTerminalConnection(
  sessionId: string,
  options?: ResolveTerminalConnectionOptions,
): Promise<TerminalConnectionInfo> {
  const origin = resolveBackendOrigin();
  const auth = await fetchTerminalToken(sessionId, options);
  if (!auth.interactive) {
    return {
      terminalUrl: null,
      interactive: false,
      reason: auth.reason,
    };
  }

  // Resolve the ttyd iframe URL against the backend origin so the ttyd
  // JavaScript inside the iframe connects its WebSocket back to the same
  // origin. This keeps the HTTP page and WebSocket endpoint aligned even
  // when the dashboard is reached through a forwarded or protected URL.
  const terminalUrl = resolveProvidedTtydHttpUrl(auth.ttydHttpUrl, auth.ttydWsUrl, origin);
  if (!terminalUrl) {
    return {
      terminalUrl: null,
      interactive: false,
      reason: "Failed to resolve the ttyd terminal URL.",
    };
  }

  return {
    terminalUrl,
    interactive: true,
    reason: null,
  };
}
