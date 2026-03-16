import { roleMeetsRequirement } from "@/lib/accessControl";
import { getDashboardAccess, guardApiAccess } from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_REMOTE_POLL_INTERVAL_MS = 700;
const TERMINAL_TRANSPORT_HEADER = "x-conductor-terminal-transport";
const TERMINAL_INTERACTIVE_HEADER = "x-conductor-terminal-interactive";
const TERMINAL_CONNECTION_PATH_HEADER = "x-conductor-terminal-connection-path";
const TERMINAL_CONNECTION_PATH = "dashboard_proxy";

type TerminalConnectionTransport = "eventstream";

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

  if (!process.env.CONDUCTOR_BACKEND_URL?.trim()) {
    return NextResponse.json(
      { error: "Rust backend URL is not configured" },
      { status: 503 }
    );
  }

  const { id } = await context.params;
  const access = await getDashboardAccess(request);
  const interactive = access.role
    ? roleMeetsRequirement(access.role, "operator")
    : false;

  // Fetch session to check for ttyd WebSocket URL
  let ttydWsUrl: string | null = null;
  try {
    const backendUrl = process.env.CONDUCTOR_BACKEND_URL?.trim() ?? "";
    const sessionRes = await fetch(`${backendUrl}/api/sessions/${encodeURIComponent(id)}`, {
      cache: "no-store",
      headers: { "x-conductor-proxy-authorized": "true" },
    });
    if (sessionRes.ok) {
      const sessionData = (await sessionRes.json()) as { metadata?: Record<string, string> };
      ttydWsUrl = sessionData?.metadata?.ttydWsUrl ?? null;
    }
  } catch {
    // Non-fatal: fall through to regular transport
  }

  if (!interactive) {
    const response = buildEventStreamConnection(
      id,
      false,
      "Live terminal control requires operator access. The terminal stays live in read-only mode.",
      startedAt
    );
    if (ttydWsUrl) {
      const body = await response.json();
      body.ttydWsUrl = ttydWsUrl;
      return applyTerminalConnectionHeaders(
        NextResponse.json(body),
        { startedAt, transport: "eventstream", interactive: false },
      );
    }
    return response;
  }

  const response = buildEventStreamConnection(id, true, null, startedAt);
  if (ttydWsUrl) {
    const body = await response.json();
    body.ttydWsUrl = ttydWsUrl;
    return applyTerminalConnectionHeaders(
      NextResponse.json(body),
      { startedAt, transport: "eventstream", interactive: true },
    );
  }
  return response;
}
