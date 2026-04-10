import { NextRequest, NextResponse } from "next/server";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { guardAndProxyToBridgeDevice, hasBridgeRelay } from "@/lib/bridgeApiProxy";
import { buildBridgeRelayAuthHeaders } from "@/lib/bridgeRelayAuth";
import { decodeBridgeSessionId } from "@/lib/bridgeSessionIds";
import { getPreviewBrowserManager } from "@/lib/devPreviewBrowser";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { loadPreviewSessionContext } from "@/lib/previewSession";
import { TERMINAL_STATUSES } from "@/lib/types";
import type { PreviewCommandRequest, PreviewStatusResponse } from "@/lib/previewTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * For bridge sessions, proxy the entire preview request to the paired device's
 * backend, which runs Puppeteer locally. This makes the preview browser work
 * on Vercel deployments where no local Chrome is available.
 */
async function tryProxyBridgePreview(request: NextRequest, id: string, options?: { requireActionGuard?: boolean }): Promise<Response | null> {
  const bridge = decodeBridgeSessionId(id);
  if (!bridge) return null;
  if (!hasBridgeRelay()) return null;

  const decodedPath = `/api/sessions/${encodeURIComponent(bridge.sessionId)}/preview`;
  return guardAndProxyToBridgeDevice(request, bridge.bridgeId, decodedPath, {
    requireActionGuard: options?.requireActionGuard,
  });
}

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

const MISSING_SESSION_PREVIEW_ERROR = "Session is no longer available.";

export async function GET(request: NextRequest, context: RouteParams): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  const { id } = await context.params;

  // Bridge sessions: proxy to the paired device's backend (has local Puppeteer)
  const bridgeProxy = await tryProxyBridgePreview(request, id);
  if (bridgeProxy) return bridgeProxy;

  const forwardedHeaders = await buildForwardedAccessHeaders(request);
  const previewContext = await loadPreviewSessionContext(id, {
    request,
    headers: forwardedHeaders,
  });
  const manager = getPreviewBrowserManager();
  if (!previewContext.session && !previewContext.error) {
    await manager.destroySession(id);
    const status = withLookupError(
      await manager.getStatus(id, []),
      MISSING_SESSION_PREVIEW_ERROR,
    );
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  }

  if (previewContext.session && TERMINAL_STATUSES.has(previewContext.session.status)) {
    await manager.destroySession(id);
    const status = withLookupError(
      await manager.getStatus(id, previewContext.candidateUrls),
      previewContext.error,
    );
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  }

  await manager.configureBridgePreview(
    id,
    previewContext.bridgePreview,
    previewContext.bridgePreview ? await buildBridgeRelayAuthHeaders(request) : undefined,
  );
  const status = withLookupError(
    await manager.getStatus(id, previewContext.candidateUrls),
    previewContext.error,
  );
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, context: RouteParams): Promise<Response> {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const { id } = await context.params;

  // Bridge sessions: proxy to the paired device's backend
  const bridgeProxy = await tryProxyBridgePreview(request, id, { requireActionGuard: true });
  if (bridgeProxy) return bridgeProxy;

  const forwardedHeaders = await buildForwardedAccessHeaders(request);
  const previewContext = await loadPreviewSessionContext(id, {
    request,
    headers: forwardedHeaders,
  });
  const manager = getPreviewBrowserManager();
  if (!previewContext.session && !previewContext.error) {
    await manager.destroySession(id);
    return NextResponse.json({ error: MISSING_SESSION_PREVIEW_ERROR }, { status: 404 });
  }

  let body: PreviewCommandRequest;
  try {
    body = await request.json() as PreviewCommandRequest;
  } catch {
    return NextResponse.json({ error: "Invalid preview command payload" }, { status: 400 });
  }

  await manager.configureBridgePreview(
    id,
    previewContext.bridgePreview,
    previewContext.bridgePreview ? await buildBridgeRelayAuthHeaders(request) : undefined,
  );

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
