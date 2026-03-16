import { roleMeetsRequirement } from "@/lib/accessControl";
import {
  getDashboardAccess,
  guardApiAccess,
} from "@/lib/auth";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TerminalTokenPayload = {
  token?: string | null;
  required?: boolean;
  expiresInSeconds?: number | null;
  error?: string;
};

function resolveBackendTerminalWsUrl(backendUrl: string, id: string): URL {
  const wsUrl = new URL(backendUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = `/api/sessions/${encodeURIComponent(id)}/terminal/ws`;
  wsUrl.search = "";
  return wsUrl;
}

/**
 * Resolve the direct ttyd WebSocket URL for a session.
 * Always asks the backend whether a terminal token is required — the backend
 * is the single source of truth for access-control decisions.
 */
async function resolvePtyWsUrl(
  request: Request,
  backendUrl: string,
  id: string
): Promise<string> {
  const wsUrl = resolveBackendTerminalWsUrl(backendUrl, id);
  wsUrl.searchParams.set("protocol", "ttyd");

  const tokenUrl = new URL(
    `/api/sessions/${encodeURIComponent(id)}/terminal/token`,
    backendUrl
  );

  let payload: TerminalTokenPayload | null = null;
  try {
    const response = await fetch(tokenUrl, {
      method: "GET",
      headers: await buildForwardedAccessHeaders(request),
      cache: "no-store",
      signal: request.signal,
    });
    payload = (await response.json().catch(() => null)) as
      | TerminalTokenPayload
      | null;
    if (!response.ok) {
      throw new Error(
        payload?.error ?? `Failed to resolve terminal token: ${response.status}`
      );
    }
  } catch (err) {
    console.warn("[Terminal Connection] Token fetch failed, proceeding without token:", {
      error: err instanceof Error ? err.message : String(err),
    });
    return wsUrl.toString();
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

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const { id } = await context.params;
  const access = await getDashboardAccess(request);
  const interactive = access.role
    ? roleMeetsRequirement(access.role, "operator")
    : false;

  if (!interactive) {
    return NextResponse.json({
      ptyWsUrl: null,
      interactive: false,
    });
  }

  const configuredBackendUrl = process.env.CONDUCTOR_BACKEND_URL?.trim();
  const backendUrl = configuredBackendUrl || "http://127.0.0.1:4749";

  let ptyWsUrl: string | null = null;
  try {
    ptyWsUrl = await resolvePtyWsUrl(request, backendUrl, id);
  } catch (error) {
    console.warn("[Terminal Connection] Failed to resolve direct terminal websocket URL", {
      error: error instanceof Error ? error.message : String(error),
      backendUrl,
      sessionId: id,
    });
  }

  return NextResponse.json({
    ptyWsUrl,
    interactive: true,
  });
}
