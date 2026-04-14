import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { Browser, Frame, HTTPRequest, Page } from "puppeteer-core";

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewLogEntry {
  id: string;
  kind: "console" | "network" | "pageerror";
  level: string;
  message: string;
  timestamp: string;
  url?: string | null;
  method?: string | null;
  status?: number | null;
  resourceType?: string | null;
}

export interface PreviewFrameInfo {
  id: string;
  name: string;
  url: string;
  parentId: string | null;
  isMain: boolean;
}

export interface PreviewDomNode {
  selector: string;
  tag: string;
  text: string;
  role: string | null;
  name: string | null;
  interactive: boolean;
  id: string | null;
  classes: string[];
  htmlPreview: string;
  bounds: PreviewBounds | null;
}

export interface PreviewElementSelection extends PreviewDomNode {
  frameId: string;
  frameName: string;
  frameUrl: string;
  attributes: Record<string, string>;
}

export interface PreviewStatusResponse {
  connected: boolean;
  candidateUrls: string[];
  currentUrl: string | null;
  title: string | null;
  tunnelUrl: string | null;
  tunnelLocalOrigin: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  frames: PreviewFrameInfo[];
  activeFrameId: string | null;
  selectedElement: PreviewElementSelection | null;
  consoleLogs: PreviewLogEntry[];
  networkLogs: PreviewLogEntry[];
  lastError: string | null;
  screenshotKey: string;
}

export interface PreviewDomResponse {
  frameId: string | null;
  nodes: PreviewDomNode[];
  truncated: boolean;
}

export type PreviewCommandRequest =
  | { command: "connect"; url: string }
  | { command: "navigate"; url: string }
  | { command: "reload" }
  | { command: "goBack" }
  | { command: "goForward" }
  | { command: "selectFrame"; frameId: string | null }
  | { command: "clickAtPoint"; x: number; y: number }
  | { command: "typeText"; text: string }
  | { command: "pressKey"; key: string }
  | { command: "selectAtPoint"; x: number; y: number }
  | { command: "selectBySelector"; selector: string; frameId?: string | null };

export interface BridgePreviewSessionConfig {
  bridgeId: string;
  sessionId: string;
  allowedOrigins: string[];
  relayUrl: string;
  forwardedHeaders: Record<string, string>;
}

export interface CreatePreviewSessionRequest {
  clientSessionId?: string | null;
  bridgePreview?: BridgePreviewSessionConfig | null;
}

export type WorkerCommandRequest =
  | PreviewCommandRequest
  | { command: "status"; candidateUrls: string[] }
  | { command: "dom"; frameId?: string | null; interactiveOnly?: boolean }
  | { command: "screenshot" };

export type WorkerCommandResponse =
  | ({ kind: "status" } & PreviewStatusResponse)
  | { kind: "screenshot"; imageBase64: string }
  | ({ kind: "dom" } & PreviewDomResponse)
  | { kind: "error"; message: string };

export interface PreviewWorkerConfig {
  port: number;
  apiKey: string;
  maxSessions: number;
  sessionTimeoutMs: number;
  chromeCommandTimeoutMs: number;
  chromePath: string;
  cloudflaredBin: string;
}

export interface PreviewSession {
  id: string;
  apiKey: string;
  clientSessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  browser: Browser;
  page: Page;
  tunnelUrl: string | null;
  tunnelProcess: ChildProcessByStdio<null, Readable, Readable> | null;
  tunnelLocalOrigin: string | null;
  bridgePreview: BridgePreviewSessionConfig | null;
  status: "active" | "closing";
  activeFrameId: string | null;
  selectedElement: PreviewElementSelection | null;
  consoleLogs: PreviewLogEntry[];
  networkLogs: PreviewLogEntry[];
  lastError: string | null;
  frameIds: WeakMap<Frame, string>;
  frameSequence: number;
  requestStarts: WeakMap<HTTPRequest, number>;
  requestInterceptionEnabled: boolean;
  lastRequestedUrl: string | null;
}

export class PreviewWorkerError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "PreviewWorkerError";
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function parseCreatePreviewSessionRequest(value: unknown): CreatePreviewSessionRequest | null {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    return null;
  }
  const clientSessionId = value.clientSessionId;
  if (clientSessionId !== undefined && clientSessionId !== null && typeof clientSessionId !== "string") {
    return null;
  }
  const normalizedClientSessionId = typeof clientSessionId === "string" && clientSessionId.trim().length > 0
    ? clientSessionId.trim()
    : null;
  if (value.bridgePreview === undefined || value.bridgePreview === null) {
    return { clientSessionId: normalizedClientSessionId, bridgePreview: null };
  }
  const bridgePreview = value.bridgePreview;
  if (!isRecord(bridgePreview)) {
    return null;
  }
  if (
    typeof bridgePreview.bridgeId !== "string"
    || typeof bridgePreview.sessionId !== "string"
    || typeof bridgePreview.relayUrl !== "string"
    || !Array.isArray(bridgePreview.allowedOrigins)
    || !bridgePreview.allowedOrigins.every((entry) => typeof entry === "string")
    || !isStringRecord(bridgePreview.forwardedHeaders)
  ) {
    return null;
  }
  return {
    clientSessionId: normalizedClientSessionId,
    bridgePreview: {
      bridgeId: bridgePreview.bridgeId,
      sessionId: bridgePreview.sessionId,
      relayUrl: bridgePreview.relayUrl,
      allowedOrigins: bridgePreview.allowedOrigins,
      forwardedHeaders: bridgePreview.forwardedHeaders,
    },
  };
}

export function parseWorkerCommandRequest(value: unknown): WorkerCommandRequest | null {
  if (!isRecord(value) || typeof value.command !== "string") {
    return null;
  }

  switch (value.command) {
    case "connect":
    case "navigate":
      return typeof value.url === "string"
        ? { command: value.command, url: value.url }
        : null;
    case "reload":
    case "goBack":
    case "goForward":
    case "screenshot":
      return { command: value.command };
    case "selectFrame":
      return isNullableString(value.frameId)
        ? { command: "selectFrame", frameId: value.frameId }
        : null;
    case "clickAtPoint":
    case "selectAtPoint":
      return isFiniteNumber(value.x) && isFiniteNumber(value.y)
        ? { command: value.command, x: value.x, y: value.y }
        : null;
    case "typeText":
      return typeof value.text === "string"
        ? { command: "typeText", text: value.text }
        : null;
    case "pressKey":
      return typeof value.key === "string"
        ? { command: "pressKey", key: value.key }
        : null;
    case "selectBySelector":
      if (typeof value.selector !== "string") {
        return null;
      }
      if (value.frameId !== undefined && !isNullableString(value.frameId)) {
        return null;
      }
      return {
        command: "selectBySelector",
        selector: value.selector,
        frameId: (value.frameId as string | null | undefined) ?? undefined,
      };
    case "status":
      return Array.isArray(value.candidateUrls) && value.candidateUrls.every((entry) => typeof entry === "string")
        ? { command: "status", candidateUrls: value.candidateUrls }
        : null;
    case "dom":
      if (value.frameId !== undefined && !isNullableString(value.frameId)) {
        return null;
      }
      if (value.interactiveOnly !== undefined && typeof value.interactiveOnly !== "boolean") {
        return null;
      }
      return {
        command: "dom",
        frameId: (value.frameId as string | null | undefined) ?? undefined,
        interactiveOnly: (value.interactiveOnly as boolean | undefined) ?? undefined,
      };
    default:
      return null;
  }
}
