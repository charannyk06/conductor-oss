import { NextRequest, NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { buildBridgeRelayAuthHeaders } from "@/lib/bridgeRelayAuth";
import { getPreviewBrowserManager } from "@/lib/devPreviewBrowser";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { loadPreviewSessionContext } from "@/lib/previewSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const { id } = await context.params;
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
    id,
    previewContext.bridgePreview,
    previewContext.bridgePreview ? await buildBridgeRelayAuthHeaders(request) : undefined,
  );

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
