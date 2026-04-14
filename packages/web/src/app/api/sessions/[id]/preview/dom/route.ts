import { NextRequest, NextResponse } from "next/server";
import { getDashboardAccess, guardApiAccess } from "@/lib/auth";
import { buildBridgeRelayAuthHeaders, resolveBridgeRelayUserId } from "@/lib/bridgeRelayAuth";
import { getPreviewBrowserManager } from "@/lib/devPreviewBrowser";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { loadPreviewSessionContext } from "@/lib/previewSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function resolvePreviewManagerSessionId(sessionId: string, userId: string | null): string {
  const normalizedUserId = userId?.trim().toLowerCase() || "anonymous-preview-user";
  return `${normalizedUserId}:${sessionId}`;
}

export async function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const { id } = await context.params;
  const access = await getDashboardAccess(request);
  const managerSessionId = resolvePreviewManagerSessionId(id, resolveBridgeRelayUserId(access));

  const forwardedHeaders = await buildForwardedAccessHeaders(request);
  const previewContext = await loadPreviewSessionContext(id, {
    request,
    headers: forwardedHeaders,
  });
  if (!previewContext.session && !previewContext.error) {
    return NextResponse.json({ error: `Session ${id} not found` }, { status: 404 });
  }

  const frameId = request.nextUrl.searchParams.get("frameId");
  const interactiveOnly = request.nextUrl.searchParams.get("interactiveOnly") === "1";
  const manager = getPreviewBrowserManager();
  await manager.configureBridgePreview(
    managerSessionId,
    previewContext.bridgePreview,
    previewContext.bridgePreview ? await buildBridgeRelayAuthHeaders(request) : undefined,
  );

  try {
    const payload = await manager.inspectDom(managerSessionId, frameId, interactiveOnly);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to inspect DOM" },
      { status: 400 },
    );
  }
}
