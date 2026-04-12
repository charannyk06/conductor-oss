import type { ComponentType } from "react";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";

/**
 * ## Session terminal implementation (supported path)
 *
 * The dashboard’s wired terminal stays iframe-based through `SessionTerminal`.
 * When a same-origin ttyd HTML facade exists, the iframe loads that route.
 * Otherwise it falls back to the embedded terminal page, which keeps the
 * current backend websocket/session architecture inside an iframe shell.
 *
 * Hosts that embed the dashboard rely on the iframe path, so avoid switching
 * to a separate non-iframe terminal implementation here without updating the
 * embed, CSP, and auth assumptions together.
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
