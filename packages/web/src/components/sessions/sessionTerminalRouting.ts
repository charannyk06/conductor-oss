import type { ComponentType } from "react";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";

/**
 * The dashboard terminal stays iframe-based, but the iframe now renders a
 * first-party xterm.js client instead of a proxied terminal HTML shell.
 */
export const SESSION_TERMINAL_IMPLEMENTATION = "native-iframe" as const;

export type SessionTerminalImplementation = typeof SESSION_TERMINAL_IMPLEMENTATION;

export function loadSessionTerminalComponent(): Promise<ComponentType<SessionTerminalProps>> {
  return import("./SessionTerminal").then((mod) => mod.SessionTerminal);
}

export function shouldUseRemoteSessionTerminal(_bridgeId?: string | null): boolean {
  return false;
}
