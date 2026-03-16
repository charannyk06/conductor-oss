import type { DashboardRoleBindings } from "@conductor-oss/core/types";
import { roleMeetsRequirement } from "@/lib/accessControl";
import {
  getDashboardAccess,
  getDashboardConfigSnapshot,
  guardApiAccess,
} from "@/lib/auth";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_REMOTE_POLL_INTERVAL_MS = 700;
const TERMINAL_TRANSPORT_HEADER = "x-conductor-terminal-transport";
const TERMINAL_INTERACTIVE_HEADER = "x-conductor-terminal-interactive";
const TERMINAL_CONNECTION_PATH_HEADER = "x-conductor-terminal-connection-path";
const TERMINAL_CONNECTION_PATH = "dashboard_proxy";

type TerminalConnectionTransport = "eventstream";

type TerminalTokenPayload = {
  token?: string | null;
  required?: boolean;
  expiresInSeconds?: number | null;
  error?: string;
};

function buildControlPaths(id: string): {
  sendPath: string;
  keysPath: string;
  resizePath: string;
} {
  return {
    sendPath: `/api/sessions/${encodeURIComponent(id)}/send`,
    keysPath: `/api/sessions/${encodeURIComponent(id)}/keys`,
    resizePath: `/api/sessions/${encodeURIComponent(id)}/terminal/resize`,
  };
}

function buildTerminalStreamProxyUrl(id: string): string {
  return `/api/sessions/${encodeURIComponent(id)}/terminal/stream`;
}

function resolveBackendTerminalWsUrl(backendUrl: string, id: string): URL {
  const wsUrl = new URL(backendUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = `/api/sessions/${encodeURIComponent(id)}/terminal/ws`;
  wsUrl.search = "";
  return wsUrl;
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function roleBindingsConfigured(
  bindings: DashboardRoleBindings | null | undefined
): boolean {
  if (!bindings) return false;
  return (
    (bindings.viewers?.length ?? 0) > 0 ||
    (bindings.operators?.length ?? 0) > 0 ||
    (bindings.admins?.length ?? 0) > 0 ||
    (bindings.viewerDomains?.length ?? 0) > 0 ||
    (bindings.operatorDomains?.length ?? 0) > 0 ||
    (bindings.adminDomains?.length ?? 0) > 0
  );
}

function terminalAccessControlEnabled(): boolean {
  const access = getDashboardConfigSnapshot().access;
  const requireAuth =
    access?.requireAuth === true ||
    (process.env.CONDUCTOR_REQUIRE_AUTH ?? "").trim().toLowerCase() ===
      "true" ||
    parseCsvEnv("CONDUCTOR_ALLOWED_EMAILS").length > 0 ||
    parseCsvEnv("CONDUCTOR_ALLOWED_DOMAINS").length > 0 ||
    parseCsvEnv("CONDUCTOR_ADMIN_EMAILS").length > 0 ||
    roleBindingsConfigured(access?.roles);

  const builtinRemoteAuthEnabled =
    (process.env.CONDUCTOR_REMOTE_ACCESS_TOKEN ?? "").trim().length > 0 &&
    (process.env.CONDUCTOR_REMOTE_SESSION_SECRET ?? "").trim().length > 0;

  return (
    requireAuth ||
    Boolean(access?.allowSignedShareLinks && builtinRemoteAuthEnabled)
  );
}

async function resolvePtyWsUrl(
  request: Request,
  backendUrl: string,
  id: string
): Promise<string> {
  const wsUrl = resolveBackendTerminalWsUrl(backendUrl, id);
  wsUrl.searchParams.set("protocol", "ttyd");

  if (!terminalAccessControlEnabled()) {
    return wsUrl.toString();
  }

  const tokenUrl = new URL(
    `/api/sessions/${encodeURIComponent(id)}/terminal/token`,
    backendUrl
  );
  const response = await fetch(tokenUrl, {
    method: "GET",
    headers: await buildForwardedAccessHeaders(request),
    cache: "no-store",
    signal: request.signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | TerminalTokenPayload
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.error ?? `Failed to resolve terminal token: ${response.status}`
    );
  }

  if (payload?.required !== true) {
    return wsUrl.toString();
  }

  const token =
    typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) {
    throw new Error("Terminal token response did not include a control token");
  }

  wsUrl.searchParams.set("token", token);
  return wsUrl.toString();
}

function formatDurationMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

function formatServerTiming(
  metrics: Array<{ name: string; durationMs: number | null }>
): string | null {
  const headerValue = metrics
    .filter(
      (metric) =>
        metric.durationMs !== null && Number.isFinite(metric.durationMs)
    )
    .map((metric) => `${metric.name};dur=${metric.durationMs?.toFixed(1)}`)
    .join(", ");

  return headerValue.length > 0 ? headerValue : null;
}

function applyTerminalConnectionHeaders(
  response: NextResponse,
  options: {
    startedAt: number;
    transport: TerminalConnectionTransport;
    interactive: boolean;
  }
): NextResponse {
  const serverTiming = formatServerTiming([
    {
      name: "terminal_connection",
      durationMs: formatDurationMs(options.startedAt),
    },
  ]);
  if (serverTiming) {
    response.headers.set("server-timing", serverTiming);
  }
  response.headers.set(TERMINAL_TRANSPORT_HEADER, options.transport);
  response.headers.set(
    TERMINAL_INTERACTIVE_HEADER,
    options.interactive ? "true" : "false"
  );
  response.headers.set(TERMINAL_CONNECTION_PATH_HEADER, TERMINAL_CONNECTION_PATH);
  return response;
}

function buildEventStreamConnection(
  id: string,
  interactive: boolean,
  fallbackReason: string | null,
  startedAt: number
): Response {
  const streamUrl = buildTerminalStreamProxyUrl(id);
  return applyTerminalConnectionHeaders(
    NextResponse.json({
      transport: "eventstream" satisfies TerminalConnectionTransport,
      wsUrl: streamUrl,
      pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
      interactive,
      requiresToken: false,
      tokenExpiresInSeconds: null,
      fallbackReason,
      stream: {
        transport: "eventstream" satisfies TerminalConnectionTransport,
        wsUrl: streamUrl,
        pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
      },
      control: {
        transport: "http",
        wsUrl: null,
        interactive,
        requiresToken: false,
        tokenExpiresInSeconds: null,
        fallbackReason,
        ...buildControlPaths(id),
      },
    }),
    {
      startedAt,
      transport: "eventstream",
      interactive,
    }
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const startedAt = performance.now();
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const { id } = await context.params;
  const access = await getDashboardAccess(request);
  const interactive = access.role
    ? roleMeetsRequirement(access.role, "operator")
    : false;

  if (!interactive) {
    return buildEventStreamConnection(
      id,
      false,
      "Live terminal control requires operator access. The terminal stays live in read-only mode.",
      startedAt
    );
  }

  // Resolve backend URL with fallback to localhost
  // In development, if CONDUCTOR_BACKEND_URL is not set,
  // default to http://127.0.0.1:4749 (standard dev backend port)
  const configuredBackendUrl = process.env.CONDUCTOR_BACKEND_URL?.trim();
  const backendUrl = configuredBackendUrl || "http://127.0.0.1:4749";
  const response = buildEventStreamConnection(id, true, null, startedAt);
  const body = (await response.json()) as Record<string, unknown>;
  try {
    const ptyWsUrl = await resolvePtyWsUrl(request, backendUrl, id);
    console.log("[Terminal Connection] Resolved ptyWsUrl:", { ptyWsUrl, backendUrl, sessionId: id });
    body.ptyWsUrl = ptyWsUrl;
  } catch (error) {
    console.warn("[Terminal Connection] Failed to resolve direct terminal websocket URL", {
      error: error instanceof Error ? error.message : String(error),
      backendUrl,
      sessionId: id,
    });
    body.ptyWsUrl = null;
  }
  return applyTerminalConnectionHeaders(
    NextResponse.json(body),
    { startedAt, transport: "eventstream", interactive: true },
  );
}
