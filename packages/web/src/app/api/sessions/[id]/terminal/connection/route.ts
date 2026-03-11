import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { roleMeetsRequirement, isLoopbackHost } from "@/lib/accessControl";
import { getDashboardAccess, guardApiAccess } from "@/lib/auth";
import { readRemoteAccessRuntimeState } from "@/lib/remoteAccessRuntime";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_REMOTE_POLL_INTERVAL_MS = 700;
const TERMINAL_TOKEN_TTL_SECONDS = 60;

type TerminalConnectionTransport = "websocket" | "snapshot";
type TerminalControlTransport = "websocket" | "http";

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

function resolveWebSocketBaseUrl(request: Request, backendUrl: string): string | null {
  let backend: URL;
  try {
    backend = new URL(backendUrl);
  } catch {
    return null;
  }

  const backendHost = backend.hostname.toLowerCase();
  if (!isLoopbackHost(backendHost)) {
    return backend.toString();
  }

  const requestHost = resolveRequestHostname(request);
  if (isLoopbackHost(requestHost)) {
    return backend.toString();
  }

  return resolveManagedRemoteBackendBaseUrl(backendUrl);
}

function buildSnapshotFallback(
  id: string,
  interactive: boolean,
  reason: string,
): Response {
  const controlPaths = buildControlPaths(id);
  return NextResponse.json({
    transport: "snapshot" satisfies TerminalConnectionTransport,
    wsUrl: null,
    pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
    interactive,
    requiresToken: false,
    tokenExpiresInSeconds: null,
    fallbackReason: reason,
    stream: {
      transport: "snapshot" satisfies TerminalConnectionTransport,
      wsUrl: null,
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
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
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
    return buildSnapshotFallback(
      id,
      false,
      "Live terminal control requires operator access. Showing snapshot recovery mode.",
    );
  }

  const webSocketBaseUrl = resolveWebSocketBaseUrl(request, backendUrl);
  if (!webSocketBaseUrl) {
    return buildSnapshotFallback(
      id,
      true,
      "A browser-connectable terminal websocket is not available for this dashboard URL. Enable the managed private link or expose the backend websocket safely.",
    );
  }

  const tokenResponse = await fetch(
    new URL(`/api/sessions/${encodeURIComponent(id)}/terminal/token`, backendUrl),
    {
      method: "GET",
      cache: "no-store",
      headers: await buildForwardedAccessHeaders(request),
    },
  );

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
      webSocketBaseUrl,
      `/api/sessions/${encodeURIComponent(id)}/terminal/ws`,
    ),
  );

  if (typeof tokenPayload?.token === "string" && tokenPayload.token.trim().length > 0) {
    wsUrl.searchParams.set("token", tokenPayload.token.trim());
  }
  const controlWsUrl = new URL(
    toWebSocketUrl(
      webSocketBaseUrl,
      `/api/sessions/${encodeURIComponent(id)}/terminal/control/ws`,
    ),
  );

  if (typeof tokenPayload?.token === "string" && tokenPayload.token.trim().length > 0) {
    controlWsUrl.searchParams.set("token", tokenPayload.token.trim());
  }

  const controlPaths = buildControlPaths(id);
  return NextResponse.json({
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
  });
}
