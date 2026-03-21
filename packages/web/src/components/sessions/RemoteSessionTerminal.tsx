"use client";

import dynamic from "next/dynamic";
import type { SessionTerminalProps } from "@/components/sessions/terminal/terminalTypes";

export const RemoteSessionTerminal = dynamic<SessionTerminalProps>(
  () => import("./RemoteSessionTerminalImpl").then((module) => module.RemoteSessionTerminal),
  { ssr: false },
);
