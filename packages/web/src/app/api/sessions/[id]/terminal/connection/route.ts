import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { roleMeetsRequirement, isLoopbackHost } from "@/lib/accessControl";
import { getDashboardAccess, guardApiAccess } from "@/lib/auth";
import { readRemoteAccessRuntimeState } from "@/lib/remoteAccessRuntime";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_REMOTE_POLL_INTERVAL_MS = 700;
const TERMINAL_TOKEN_TTL_SECONDS = 60;
const TERMINAL_TRANSPORT_HEADER = "x-conductor-terminal-transport";
const TERMINAL_INTERACTIVE_HEADER = "x-conductor-terminal-interactive";
const TERMINAL_CONNECTION_PATH_HEADER = "x-conductor-terminal-connection-path";

type TerminalConnectionTransport = "websocket" | "snapshot" | "eventstream";
type TerminalControlTransport = "websocket" | "http";
type TerminalConnectionPath = "direct" | "managed_remote" | "dashboard_proxy" | "auth_limited" | "unavailable";

type ResolvedWebSocketBaseUrl = {
  baseUrl: string | null;
  connectionPath: Exclude<TerminalConnectionPath, "auth_limited">;
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

function toWebSocketUrl(baseUrl: string, pathname: string): string {
  const url = new URL(pathname, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function buildTerminalStreamProxyUrl(id: string): string {
  return `/api/sessions/${encodeURIComponent(id)}/terminal/stream`;
}

function resolveRequestHostname(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const fallbackHost = request.headers.get("host")?.trim();

  for (const candidate of [forwardedHost, fallbackHost]) {
    if (!candidate) continue;
    try {
      return new URL(`http://${candidate}`).hostname.toLowerCase();
    } catch {
      return candidate.split(":")[0]?.trim().toLowerCase() ?? "";
    }
  }

  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function resolveManagedRemoteBackendBaseUrl(backendUrl: string): string | null {
  const runtimeState = readRemoteAccessRuntimeState();
  if (runtimeState?.provider !== "tailscale" || runtimeState.status !== "ready" || !runtimeState.publicUrl) {
    return null;
  }

  try {
    const backend = new URL(backendUrl);
    const remote = new URL(runtimeState.publicUrl);
    const port = backend.port || (backend.protocol === "https:" ? "443" : "80");
    remote.port = port;
    remote.pathname = "/";
    remote.search = "";
    remote.hash = "";
    return remote.toString();
  } catch {
    return null;
  }
}

function resolveWebSocketBaseUrl(request: Request, backendUrl: string): ResolvedWebSocketBaseUrl {
  let backend: URL;
  try {
    backend = new URL(backendUrl);
  } catch {
    return { baseUrl: null, connectionPath: "unavailable" };
  }

  const backendHost = backend.hostname.toLowerCase();
  if (!isLoopbackHost(backendHost)) {
    return { baseUrl: backend.toString(), connectionPath: "direct" };
  }

  const requestHost = resolveRequestHostname(request);
  if (isLoopbackHost(requestHost)) {
    return { baseUrl: backend.toString(), connectionPath: "direct" };
  }

  const managedRemoteBaseUrl = resolveManagedRemoteBackendBaseUrl(backendUrl);
  return managedRemoteBaseUrl
    ? { baseUrl: managedRemoteBaseUrl, connectionPath: "managed_remote" }
    : { baseUrl: null, connectionPath: "unavailable" };
}

function formatDurationMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

function formatServerTiming(metrics: Array<{ name: string; durationMs: number | null }>): string | null {
  const headerValue = metrics
    .filter((metric) => metric.durationMs !== null && Number.isFinite(metric.durationMs))
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
    connectionPath: TerminalConnectionPath;
    tokenFetchMs?: number | null;
  },
): NextResponse {
  const serverTiming = formatServerTiming([
    { name: "terminal_connection", durationMs: formatDurationMs(options.startedAt) },
    { name: "terminal_token", durationMs: options.tokenFetchMs ?? null },
  ]);
  if (serverTiming) {
    response.headers.set("server-timing", serverTiming);
  }
  response.headers.set(TERMINAL_TRANSPORT_HEADER, options.transport);
  response.headers.set(TERMINAL_INTERACTIVE_HEADER, options.interactive ? "true" : "false");
  response.headers.set(TERMINAL_CONNECTION_PATH_HEADER, options.connectionPath);
  return response;
}

function buildEventStreamConnection(
  id: string,
  interactive: boolean,
  reason: string | null,
  startedAt: number,
  connectionPath: TerminalConnectionPath,
): Response {
  const controlPaths = buildControlPaths(id);
  const streamUrl = buildTerminalStreamProxyUrl(id);
  return applyTerminalConnectionHeaders(NextResponse.json({
    transport: "eventstream" satisfies TerminalConnectionTransport,
    wsUrl: streamUrl,
    pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
    interactive,
    requiresToken: false,
    tokenExpiresInSeconds: null,
    fallbackReason: reason,
    stream: {
      transport: "eventstream" satisfies TerminalConnectionTransport,
      wsUrl: streamUrl,
      pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
    },
    control: {
      transport: "http" satisfies TerminalControlTransport,
      wsUrl: null,
      interactive,
      requiresToken: false,
      tokenExpiresInSeconds: null,
      fallbackReason: reason,
      ...controlPaths,
    },
  }), {
    startedAt,
    transport: "eventstream",
    interactive,
    connectionPath,
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const startedAt = performance.now();
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const backendUrl = process.env.CONDUCTOR_BACKEND_URL?.trim();
  if (!backendUrl) {
    return NextResponse.json(
      { error: "Rust backend URL is not configured" },
      { status: 503 },
    );
  }

  const { id } = await context.params;
  const access = await getDashboardAccess(request);
  const interactive = access.role ? roleMeetsRequirement(access.role, "operator") : false;
  if (!interactive) {
    return buildEventStreamConnection(
      id,
      false,
      "Live terminal control requires operator access. The terminal stays live in read-only mode.",
      startedAt,
      "auth_limited",
    );
  }

  const resolvedWebSocket = resolveWebSocketBaseUrl(request, backendUrl);
  if (!resolvedWebSocket.baseUrl) {
    return buildEventStreamConnection(
      id,
      true,
      "A browser-connectable terminal websocket is not available for this dashboard URL. Live terminal output is being proxied through the dashboard.",
      startedAt,
      "dashboard_proxy",
    );
  }

  const tokenStartedAt = performance.now();
  const tokenResponse = await fetch(
    new URL(`/api/sessions/${encodeURIComponent(id)}/terminal/token`, backendUrl),
    {
      method: "GET",
      cache: "no-store",
      headers: await buildForwardedAccessHeaders(request),
    },
  );
  const tokenFetchMs = formatDurationMs(tokenStartedAt);

  const tokenPayload = (await tokenResponse.json().catch(() => null)) as
    | {
        token?: string | null;
        required?: boolean;
        expiresInSeconds?: number | null;
        error?: string;
      }
    | null;

  if (!tokenResponse.ok) {
    return NextResponse.json(
      { error: tokenPayload?.error ?? `Failed to resolve terminal token: ${tokenResponse.status}` },
      { status: tokenResponse.status },
    );
  }

  const wsUrl = new URL(
    toWebSocketUrl(
      resolvedWebSocket.baseUrl,
      `/api/sessions/${encodeURIComponent(id)}/terminal/ws`,
    ),
  );

  if (typeof tokenPayload?.token === "string" && tokenPayload.token.trim().length > 0) {
    wsUrl.searchParams.set("token", tokenPayload.token.trim());
  }
  const controlWsUrl = new URL(
    toWebSocketUrl(
      resolvedWebSocket.baseUrl,
      `/api/sessions/${encodeURIComponent(id)}/terminal/control/ws`,
    ),
  );

  if (typeof tokenPayload?.token === "string" && tokenPayload.token.trim().length > 0) {
    controlWsUrl.searchParams.set("token", tokenPayload.token.trim());
  }

  const controlPaths = buildControlPaths(id);
  return applyTerminalConnectionHeaders(NextResponse.json({
    transport: "websocket" satisfies TerminalConnectionTransport,
    wsUrl: wsUrl.toString(),
    pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
    interactive: true,
    requiresToken: tokenPayload?.required === true || typeof tokenPayload?.token === "string",
    tokenExpiresInSeconds: typeof tokenPayload?.expiresInSeconds === "number"
      ? tokenPayload.expiresInSeconds
      : (typeof tokenPayload?.token === "string" ? TERMINAL_TOKEN_TTL_SECONDS : null),
    fallbackReason: null,
    stream: {
      transport: "websocket" satisfies TerminalConnectionTransport,
      wsUrl: wsUrl.toString(),
      pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
    },
    control: {
      transport: "websocket" satisfies TerminalControlTransport,
      wsUrl: controlWsUrl.toString(),
      interactive: true,
      requiresToken: tokenPayload?.required === true || typeof tokenPayload?.token === "string",
      tokenExpiresInSeconds: typeof tokenPayload?.expiresInSeconds === "number"
        ? tokenPayload.expiresInSeconds
        : (typeof tokenPayload?.token === "string" ? TERMINAL_TOKEN_TTL_SECONDS : null),
      fallbackReason: null,
      ...controlPaths,
    },
  }), {
    startedAt,
    transport: "websocket",
    interactive: true,
    connectionPath: resolvedWebSocket.connectionPath,
    tokenFetchMs,
  });
}
