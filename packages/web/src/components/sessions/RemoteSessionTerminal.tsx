"use client";

/**
 * Relay WebSocket + xterm.js terminal, kept as an alternate full-page surface.
 * The product path inside SessionDetail is still the iframe shell, but that shell
 * now renders our first-party xterm client rather than proxied terminal HTML.
 */
import dynamic from "next/dynamic";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";

export const RemoteSessionTerminal = dynamic<SessionTerminalProps>(
  () => import("./RemoteSessionTerminalImpl").then((module) => module.RemoteSessionTerminal),
  { ssr: false },
);
