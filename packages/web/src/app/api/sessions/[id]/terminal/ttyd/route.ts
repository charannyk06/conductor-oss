import { guardApiAccess } from "@/lib/auth";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { proxyToBridgeDevice } from "@/lib/bridgeApiProxy";
import { proxyToRustOrUnavailable } from "@/lib/rustBackendProxy";
import {
  BRIDGE_TTYD_RELAY_WS_QUERY_PARAM,
  buildPatchedTtydHtmlResponse,
  createBridgeTtydRelayWebSocketUrl,
  injectBridgeTtydRelayShim,
  injectTtydResizeShim,
  resolveBridgeSessionTarget,
} from "@/lib/bridgeTtyd";
import { readTtydHtmlResponse } from "@/lib/ttydHtmlResponse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function injectResizeShimIntoResponse(proxied: Response): Promise<Response> {
  const html = await readTtydHtmlResponse(proxied);
  if (html === null) {
    return proxied;
  }

  return buildPatchedTtydHtmlResponse(proxied, injectTtydResizeShim(html));
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const target = resolveBridgeSessionTarget(id, request);
  if (!target) {
    // Non-bridge session: proxy to Rust backend, then inject resize shim into HTML.
    const denied = await guardApiAccess(request, "viewer");
    if (denied) {
      return denied;
    }

    const proxied = await proxyToRustOrUnavailable(
      request,
      `/api/sessions/${encodeURIComponent(id ?? "")}/terminal/ttyd`,
      {
        headers: await buildForwardedAccessHeaders(request),
      },
    );

    return injectResizeShimIntoResponse(proxied);
  }

  // Bridge session: proxy to bridge device, inject relay shim + resize shim.
  const denied = await guardApiAccess(request, "viewer");
  if (denied) {
    return denied;
  }

  const proxied = await proxyToBridgeDevice(
    request,
    target.bridgeId,
    `/api/sessions/${encodeURIComponent(target.sessionId)}/terminal/ttyd`,
    {
      pathOverride: `/api/sessions/${encodeURIComponent(target.sessionId)}/terminal/ttyd`,
    },
  );

  const html = await readTtydHtmlResponse(proxied);
  if (html === null) {
    return proxied;
  }

  let relayTtydWsUrl = new URL(request.url).searchParams.get(BRIDGE_TTYD_RELAY_WS_QUERY_PARAM)?.trim() ?? "";
  if (!relayTtydWsUrl) {
    relayTtydWsUrl = await createBridgeTtydRelayWebSocketUrl(
      request,
      target.bridgeId,
      target.sessionId,
    );
  }

  const patchedHtml = injectTtydResizeShim(
    injectBridgeTtydRelayShim(html, relayTtydWsUrl),
  );

  return buildPatchedTtydHtmlResponse(proxied, patchedHtml);
}
