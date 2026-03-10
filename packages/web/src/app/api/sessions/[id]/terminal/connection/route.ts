import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { isLoopbackHost } from "@/lib/accessControl";
import { guardApiAccess } from "@/lib/auth";
import { readRemoteAccessRuntimeState } from "@/lib/remoteAccessRuntime";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_REMOTE_POLL_INTERVAL_MS = 700;

type TerminalConnectionTransport = "websocket" | "http-poll";

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

function resolveTransport(request: Request, backendUrl: string): TerminalConnectionTransport {
  const requestHost = resolveRequestHostname(request);
  const backendHost = new URL(backendUrl).hostname.toLowerCase();
  return isLoopbackHost(requestHost) && isLoopbackHost(backendHost)
    ? "websocket"
    : "http-poll";
}

function resolveRemoteBackendBaseUrl(backendUrl: string): string | null {
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

  const transport = resolveTransport(request, backendUrl);
  let remoteBackendBaseUrl: string | null = null;
  if (transport === "http-poll") {
    remoteBackendBaseUrl = resolveRemoteBackendBaseUrl(backendUrl);
  }
  const effectiveTransport: TerminalConnectionTransport = transport === "http-poll" && remoteBackendBaseUrl
    ? "websocket"
    : transport;
  if (effectiveTransport === "http-poll") {
    return NextResponse.json({
      transport: effectiveTransport,
      wsUrl: null,
      pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
    });
  }

  const { id } = await context.params;
  const tokenResponse = await fetch(
    new URL(`/api/sessions/${encodeURIComponent(id)}/terminal/token`, backendUrl),
    {
      method: "GET",
      cache: "no-store",
      headers: await buildForwardedAccessHeaders(request),
    },
  );

  const tokenPayload = (await tokenResponse.json().catch(() => null)) as
    | { token?: string | null; error?: string }
    | null;

  if (!tokenResponse.ok) {
    return NextResponse.json(
      { error: tokenPayload?.error ?? `Failed to resolve terminal token: ${tokenResponse.status}` },
      { status: tokenResponse.status },
    );
  }

  const wsUrl = new URL(
    toWebSocketUrl(
      remoteBackendBaseUrl ?? backendUrl,
      `/api/sessions/${encodeURIComponent(id)}/terminal/ws`,
    ),
  );

  if (typeof tokenPayload?.token === "string" && tokenPayload.token.trim().length > 0) {
    wsUrl.searchParams.set("token", tokenPayload.token.trim());
  }

  return NextResponse.json({
    transport: effectiveTransport,
    wsUrl: wsUrl.toString(),
    pollIntervalMs: DEFAULT_REMOTE_POLL_INTERVAL_MS,
  });
}
