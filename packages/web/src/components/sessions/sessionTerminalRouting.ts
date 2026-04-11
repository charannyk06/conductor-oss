import type { ComponentType } from "react";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";

/**
 * ## Session terminal implementation (supported path)
 *
 * The dashboard’s **only** wired terminal is the **ttyd iframe** (`SessionTerminal`):
 * browser → Next `/api/sessions/:id/terminal/ttyd` (same-origin) → Rust facade →
 * loopback ttyd → one PTY per session.
 *
 * Hosts that embed the dashboard (e.g. **Polyscope** in a WKWebView) rely on this
 * path: the iframe loads HTML from the proxied ttyd route; `next.config` relaxes
 * `frame-ancestors` for proxied ttyd routes under `/api/sessions/.../terminal/ttyd` so the frame can render.
 * Do not switch embedders to a second terminal stack without updating CSP and
 * auth cookie paths.
 *
 * ## Not used by default
 *
 * `RemoteSessionTerminal` (xterm + relay WebSocket) remains in the tree for
 * optional / experimental flows but is **not** selected here — `shouldUseRemoteSessionTerminal`
 * stays `false` until a product decision wires it with bridge/relay routes.
 */

export const SESSION_TERMINAL_IMPLEMENTATION = "ttyd-iframe" as const;

export type SessionTerminalImplementation = typeof SESSION_TERMINAL_IMPLEMENTATION;

/** Loader for `next/dynamic` — always resolves to the ttyd iframe terminal. */
export function loadSessionTerminalComponent(): Promise<ComponentType<SessionTerminalProps>> {
  return import("./SessionTerminal").then((mod) => mod.SessionTerminal);
}

/**
 * When `true`, the dashboard would use `RemoteSessionTerminal` (relay WebSocket + xterm)
 * instead of the ttyd iframe. Kept for future bridge-only UX; **always false** today.
 */
export function shouldUseRemoteSessionTerminal(_bridgeId?: string | null): boolean {
  return false;
}
