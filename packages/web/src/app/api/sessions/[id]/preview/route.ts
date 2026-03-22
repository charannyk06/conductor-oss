import { NextRequest, NextResponse } from "next/server";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { maybeProxyBridgeSessionRequest } from "@/lib/bridgeSessionProxy";
import { getPreviewBrowserManager } from "@/lib/devPreviewBrowser";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { loadPreviewSessionContext } from "@/lib/previewSession";
import type { PreviewCommandRequest, PreviewStatusResponse } from "@/lib/previewTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function withLookupError(
  status: PreviewStatusResponse,
  lookupError: string | null,
): PreviewStatusResponse {
  if (!lookupError || status.connected || status.lastError) {
    return status;
  }

  return {
    ...status,
    lastError: lookupError,
  };
}

export async function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  const { id } = await context.params;
  const proxied = await maybeProxyBridgeSessionRequest(
    request,
    id,
    (sessionId) => `/api/sessions/${encodeURIComponent(sessionId)}/preview`,
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

  const manager = getPreviewBrowserManager();
  const status = withLookupError(
    await manager.getStatus(id, previewContext.candidateUrls),
    previewContext.error,
  );
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, context: RouteParams): Promise<Response> {
  const { id } = await context.params;
  const proxied = await maybeProxyBridgeSessionRequest(
    request,
    id,
    (sessionId) => `/api/sessions/${encodeURIComponent(sessionId)}/preview`,
    { role: "operator", requireActionGuard: true },
  );
  if (proxied) return proxied;

  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const previewContext = await loadPreviewSessionContext(id, {
    headers: await buildForwardedAccessHeaders(request),
  });
  if (!previewContext.session && !previewContext.error) {
    return NextResponse.json({ error: `Session ${id} not found` }, { status: 404 });
  }

  let body: PreviewCommandRequest;
  try {
    body = await request.json() as PreviewCommandRequest;
  } catch {
    return NextResponse.json({ error: "Invalid preview command payload" }, { status: 400 });
  }

  const manager = getPreviewBrowserManager();

  try {
    await manager.runCommand(id, body);
    const status = withLookupError(
      await manager.getStatus(id, previewContext.candidateUrls),
      previewContext.error,
    );
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = withLookupError(
      await manager.getStatus(id, previewContext.candidateUrls),
      previewContext.error,
    );
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Preview command failed",
        status,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
