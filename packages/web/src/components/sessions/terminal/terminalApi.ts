/**
 * Terminal API utilities.
 * Connection resolution is client-side for the WS URL — the browser builds
 * the ttyd endpoint directly. Authentication still uses a lightweight
 * Next.js proxy to obtain a short-lived terminal token.
 */

import type { TerminalConnectionInfo } from "./terminalTypes";

// ---------------------------------------------------------------------------
// Direct backend URL resolution — no server round-trip
// ---------------------------------------------------------------------------

/**
 * Resolve the Rust backend origin from the browser.
 *
 * Priority:
 *  1. `NEXT_PUBLIC_CONDUCTOR_BACKEND_URL` (build-time env var)
 *  2. Dev mode heuristic: if the page is served from port 3000 the backend
 *     lives on the same hostname at port 4749.
 *  3. Same origin (production: Rust backend serves the dashboard).
 */
function resolveBackendOrigin(): string {
  // Build-time env var (NEXT_PUBLIC_ prefix exposes it to the client bundle)
  const envUrl = process.env.NEXT_PUBLIC_CONDUCTOR_BACKEND_URL?.trim();
  if (envUrl) return envUrl;

  if (typeof window === "undefined") return "http://127.0.0.1:4749";

  const { protocol, hostname, port } = window.location;

  // Dev mode: Next.js dev server on :3000, Rust backend on :4749
  if (port === "3000") {
    return `${protocol}//${hostname}:4749`;
  }

  // Production / standalone: backend serves dashboard at the same origin
  return window.location.origin;
}

/**
 * Fetch a terminal token via the Next.js proxy (which handles auth).
 * The token is required by the Rust backend WebSocket endpoint.
 * Fail closed on proxy or backend errors so the browser does not attempt an
 * unauthenticated ttyd websocket with a missing or stale token.
 */
type TerminalTokenResult =
  | { interactive: true; token: string | null }
  | { interactive: false; token: null };

async function fetchTerminalToken(sessionId: string): Promise<TerminalTokenResult> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/token`, {
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as
    | { token?: string; required?: boolean; error?: string }
    | null;

  if (res.status === 401 || res.status === 403) {
    return {
      interactive: false,
      token: null,
    };
  }

  if (!res.ok) {
    throw new Error(data?.error ?? `Failed to resolve terminal token: ${res.status}`);
  }

  if (data?.required !== true) {
    return {
      interactive: true,
      token: null,
    };
  }

  const token = typeof data?.token === "string" ? data.token.trim() : "";
  if (token.length === 0) {
    throw new Error("Terminal token response did not include a ttyd token");
  }

  return {
    interactive: true,
    token,
  };
}

/**
 * Build the direct ttyd WebSocket URL for a session.
 *
 * 1. Fetch a short-lived token via Next.js proxy (one HTTP call, handles auth).
 * 2. Construct the WebSocket URL pointing directly at the Rust backend.
 *
 * The WebSocket stream itself is direct — no middleware in the data path.
 */
export async function resolveTerminalConnection(sessionId: string): Promise<TerminalConnectionInfo> {
  const origin = resolveBackendOrigin();
  const wsProtocol = origin.startsWith("https") ? "wss:" : "ws:";
  const url = new URL(origin);
  const auth = await fetchTerminalToken(sessionId);
  if (!auth.interactive) {
    return {
      ptyWsUrl: null,
      interactive: false,
    };
  }
  const tokenParam = auth.token ? `&token=${encodeURIComponent(auth.token)}` : "";
  const ptyWsUrl = `${wsProtocol}//${url.host}/api/sessions/${encodeURIComponent(sessionId)}/terminal/ws?protocol=ttyd${tokenParam}`;

  return { ptyWsUrl, interactive: true };
}
