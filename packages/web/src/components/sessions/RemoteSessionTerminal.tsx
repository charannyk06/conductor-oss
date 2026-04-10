"use client";

/**
 * Relay WebSocket + xterm.js terminal — **not** wired into `SessionDetail` today.
 * The product path is the ttyd iframe (`SessionTerminal` via `sessionTerminalRouting`).
 * Kept for optional bridge/relay experiments; do not use for Polyscope-style embeds
 * without a deliberate routing change.
 */
import dynamic from "next/dynamic";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";

export const RemoteSessionTerminal = dynamic<SessionTerminalProps>(
  () => import("./RemoteSessionTerminalImpl").then((module) => module.RemoteSessionTerminal),
  { ssr: false },
);
