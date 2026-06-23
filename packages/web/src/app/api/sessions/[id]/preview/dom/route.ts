import { NextRequest, NextResponse } from "next/server";
import { getDashboardAccess, guardApiAccess } from "@/lib/auth";
import { buildBridgeRelayAuthHeaders, resolveBridgeRelayUserId } from "@/lib/bridgeRelayAuth";
import { getPreviewBrowserManager } from "@/lib/devPreviewBrowser";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import {
  normalizePreviewBridgeSetupError,
  resolvePreviewManagerSessionId,
} from "@/lib/previewManagerSession";
import { loadPreviewSessionContext } from "@/lib/previewSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function readPreviewUrlHint(request: NextRequest): string | null {
  const value = request.nextUrl.searchParams.get("previewUrlHint");
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const { id } = await context.params;
  const access = await getDashboardAccess(request);
  let managerSessionId: string;
  try {
    managerSessionId = resolvePreviewManagerSessionId(id, resolveBridgeRelayUserId(access));
  } catch (error) {
    const { status, message } = normalizePreviewBridgeSetupError(error);
    return NextResponse.json({ error: message }, { status });
  }

  const forwardedHeaders = await buildForwardedAccessHeaders(request);
  const previewContext = await loadPreviewSessionContext(id, {
    request,
    headers: forwardedHeaders,
    previewUrlHint: readPreviewUrlHint(request),
  });
  if (!previewContext.session && !previewContext.error) {
    return NextResponse.json({ error: `Session ${id} not found` }, { status: 404 });
  }

  const frameId = request.nextUrl.searchParams.get("frameId");
  const interactiveOnly = request.nextUrl.searchParams.get("interactiveOnly") === "1";
  const manager = getPreviewBrowserManager();
  try {
    await manager.configureBridgePreview(
      managerSessionId,
      previewContext.bridgePreview,
      previewContext.bridgePreview ? await buildBridgeRelayAuthHeaders(request) : undefined,
    );
  } catch (error) {
    const { status, message } = normalizePreviewBridgeSetupError(error);
    return NextResponse.json({ error: message }, { status });
  }

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
