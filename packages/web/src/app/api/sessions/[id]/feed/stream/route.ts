import { getDashboardAccess, guardApiAccess } from "@/lib/auth";
import { forwardedAccessAuthenticated } from "@/lib/guardedRustProxy";
import { hasRustBackend } from "@/lib/rustBackendProxy";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE streaming endpoint.
 *
 * In Next.js standalone mode, the default route-handler pipeline may buffer
 * the entire Response body (via blob()) before sending, which kills SSE.
 *
 * We handle SSE manually here: open a fetch to the Rust backend, then pipe
 * the raw readable stream back with the correct headers so Next.js treats it
 * as an unbuffered passthrough.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  if (!hasRustBackend()) {
    return NextResponse.json(
      { error: "Rust backend URL is not configured" },
      { status: 503 },
    );
  }

  const { id } = await context.params;
  const backendUrl = process.env.CONDUCTOR_BACKEND_URL?.trim() ?? "";
  const target = new URL(
    `/api/sessions/${encodeURIComponent(id)}/feed/stream`,
    backendUrl,
  );

  // Forward query params (e.g. ?since=)
  const incomingUrl = new URL(request.url);
  target.search = incomingUrl.search;

  const access = await getDashboardAccess(request);
  const headers = new Headers({
    "Accept": "text/event-stream",
    "Cache-Control": "no-cache",
    "x-conductor-proxy-authorized": "true",
    "x-conductor-access-authenticated": forwardedAccessAuthenticated(access) ? "true" : "false",
  });
  if (access.role) headers.set("x-conductor-access-role", access.role);
  if (access.email) headers.set("x-conductor-access-email", access.email);
  if (access.provider) headers.set("x-conductor-access-provider", access.provider);

  const upstream = await fetch(target, {
    method: "GET",
    headers,
    cache: "no-store",
    signal: request.signal,
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
    });
  }

  // Return the raw stream with SSE headers.
  // Do NOT use NextResponse — it may buffer.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
