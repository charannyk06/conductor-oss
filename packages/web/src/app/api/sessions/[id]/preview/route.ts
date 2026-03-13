import { NextRequest, NextResponse } from "next/server";
import { guardApiAccess } from "@/lib/auth";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { loadPreviewSessionContext, type PreviewSessionContext } from "@/lib/previewSession";
import type { PreviewStatusResponse } from "@/lib/previewTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function buildPreviewStatus(previewContext: PreviewSessionContext): PreviewStatusResponse {
  const currentUrl = previewContext.candidateUrls[0] ?? null;

  return {
    connected: currentUrl !== null,
    candidateUrls: previewContext.candidateUrls,
    currentUrl,
    title: null,
    frames: [],
    activeFrameId: null,
    selectedElement: null,
    consoleLogs: [],
    networkLogs: [],
    lastError: previewContext.error,
    screenshotKey: currentUrl ?? "",
  };
}

export async function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const { id } = await context.params;
  const previewContext = await loadPreviewSessionContext(id, {
    headers: await buildForwardedAccessHeaders(request),
  });
  if (!previewContext.session && !previewContext.error) {
    return NextResponse.json({ error: `Session ${id} not found` }, { status: 404 });
  }

  return NextResponse.json(buildPreviewStatus(previewContext), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  return NextResponse.json(
    {
      error: "Interactive preview controls were removed. Preview now renders the resolved URL directly.",
    },
    { status: 405, headers: { "Cache-Control": "no-store" } },
  );
}
