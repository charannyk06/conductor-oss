import { NextRequest, NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { maybeProxyBridgeSessionRequest } from "@/lib/bridgeSessionProxy";
import { getPreviewBrowserManager } from "@/lib/devPreviewBrowser";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { loadPreviewSessionContext } from "@/lib/previewSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  const { id } = await context.params;
  const proxied = await maybeProxyBridgeSessionRequest(
    request,
    id,
    (sessionId) => `/api/sessions/${encodeURIComponent(sessionId)}/preview/dom`,
    { role: "viewer" },
  );
  if (proxied) return proxied;

  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const previewContext = await loadPreviewSessionContext(id, {
    headers: await buildForwardedAccessHeaders(request),
  });
  if (!previewContext.session && !previewContext.error) {
    return NextResponse.json({ error: `Session ${id} not found` }, { status: 404 });
  }

  const frameId = request.nextUrl.searchParams.get("frameId");
  const interactiveOnly = request.nextUrl.searchParams.get("interactiveOnly") === "1";
  const manager = getPreviewBrowserManager();

  try {
    const payload = await manager.inspectDom(id, frameId, interactiveOnly);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to inspect DOM" },
      { status: 400 },
    );
  }
}
