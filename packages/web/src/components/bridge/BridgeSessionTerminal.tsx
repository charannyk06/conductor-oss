"use client";

import dynamic from "next/dynamic";
import type { BridgeSessionTerminalProps } from "./BridgeSessionTerminalImpl";

export const BridgeSessionTerminal = dynamic<BridgeSessionTerminalProps>(
  () => import("./BridgeSessionTerminalImpl").then((module) => module.BridgeSessionTerminal),
  { ssr: false },
);
