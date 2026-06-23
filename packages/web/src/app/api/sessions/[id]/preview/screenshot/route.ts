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
    const screenshot = await manager.takeScreenshot(managerSessionId);
    if (!screenshot) {
      return NextResponse.json({ error: "Preview is not connected" }, { status: 404 });
    }
    return new Response(Buffer.from(screenshot), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to capture preview screenshot" },
      { status: 400 },
    );
  }
}
