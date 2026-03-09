import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { guardApiAccess } from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function toWebSocketUrl(baseUrl: string, pathname: string): string {
  const url = new URL(pathname, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
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
      backendUrl,
      `/api/sessions/${encodeURIComponent(id)}/terminal/ws`,
    ),
  );

  if (typeof tokenPayload?.token === "string" && tokenPayload.token.trim().length > 0) {
    wsUrl.searchParams.set("token", tokenPayload.token.trim());
  }

  return NextResponse.json({
    wsUrl: wsUrl.toString(),
  });
}
