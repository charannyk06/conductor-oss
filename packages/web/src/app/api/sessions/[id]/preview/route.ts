import { NextRequest, NextResponse } from "next/server";
import { getDashboardAccess, guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { buildBridgeRelayAuthHeaders, resolveBridgeRelayUserId } from "@/lib/bridgeRelayAuth";
import { getPreviewBrowserManager } from "@/lib/devPreviewBrowser";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import {
  normalizePreviewBridgeSetupError,
  resolvePreviewManagerSessionId,
} from "@/lib/previewManagerSession";
import { loadPreviewSessionContext } from "@/lib/previewSession";
import { TERMINAL_STATUSES } from "@/lib/types";
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

const MISSING_SESSION_PREVIEW_ERROR = "Session is no longer available.";

function readPreviewUrlHint(request: NextRequest): string | null {
  const value = request.nextUrl.searchParams.get("previewUrlHint");
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveCommandPreviewUrlHint(command: PreviewCommandRequest): string | null {
  if (command.command === "connect" || command.command === "navigate") {
    const trimmed = command.url.trim();
    return trimmed ? trimmed : null;
  }
  return null;
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
  const manager = getPreviewBrowserManager();
  if (!previewContext.session && !previewContext.error) {
    await manager.destroySession(managerSessionId);
    const status = withLookupError(
      await manager.getStatus(managerSessionId, []),
      MISSING_SESSION_PREVIEW_ERROR,
    );
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  }

  if (previewContext.session && TERMINAL_STATUSES.has(previewContext.session.status)) {
    await manager.destroySession(managerSessionId);
    const status = withLookupError(
      await manager.getStatus(managerSessionId, previewContext.candidateUrls),
      previewContext.error,
    );
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  }

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

  const status = withLookupError(
    await manager.getStatus(managerSessionId, previewContext.candidateUrls),
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
  const access = await getDashboardAccess(request);
  let managerSessionId: string;
  try {
    managerSessionId = resolvePreviewManagerSessionId(id, resolveBridgeRelayUserId(access));
  } catch (error) {
    const { status, message } = normalizePreviewBridgeSetupError(error);
    return NextResponse.json({ error: message }, { status });
  }

  let body: PreviewCommandRequest;
  try {
    body = await request.json() as PreviewCommandRequest;
  } catch {
    return NextResponse.json({ error: "Invalid preview command payload" }, { status: 400 });
  }

  const forwardedHeaders = await buildForwardedAccessHeaders(request);
  const previewContext = await loadPreviewSessionContext(id, {
    request,
    requestBody: body,
    headers: forwardedHeaders,
    previewUrlHint: resolveCommandPreviewUrlHint(body) ?? readPreviewUrlHint(request),
  });
  const manager = getPreviewBrowserManager();
  if (!previewContext.session && !previewContext.error) {
    await manager.destroySession(managerSessionId);
    return NextResponse.json({ error: MISSING_SESSION_PREVIEW_ERROR }, { status: 404 });
  }

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
    await manager.runCommand(managerSessionId, body);
    const status = withLookupError(
      await manager.getStatus(managerSessionId, previewContext.candidateUrls),
      previewContext.error,
    );
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = withLookupError(
      await manager.getStatus(managerSessionId, previewContext.candidateUrls),
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
