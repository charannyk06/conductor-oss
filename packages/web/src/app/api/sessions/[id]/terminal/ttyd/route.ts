import { guardApiAccess } from "@/lib/auth";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { proxyToBridgeDevice } from "@/lib/bridgeApiProxy";
import { proxyToRustOrUnavailable } from "@/lib/rustBackendProxy";
import {
  BRIDGE_TTYD_RELAY_WS_QUERY_PARAM,
  createBridgeTtydRelayWebSocketUrl,
  injectBridgeTtydRelayShim,
  injectTtydResizeShim,
  resolveBridgeSessionTarget,
} from "@/lib/bridgeTtyd";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * Inject the resize coordination shim into a proxied HTML response.
 * Falls back to the original response if the content is not HTML or
 * reading the body fails.
 */
async function injectResizeShimIntoResponse(proxied: Response): Promise<Response> {
  const contentType = proxied.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/html")) {
    return proxied;
  }

  let html: string;
  try {
    html = await proxied.text();
  } catch {
    return proxied;
  }

  const patched = injectTtydResizeShim(html);
  return new Response(patched, {
    status: proxied.status,
    statusText: proxied.statusText,
    headers: new Headers(proxied.headers),
  });
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

  const contentType = proxied.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/html")) {
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

  let html = await proxied.text();
  html = injectBridgeTtydRelayShim(html, relayTtydWsUrl);
  html = injectTtydResizeShim(html);

  return new Response(html, {
    status: proxied.status,
    statusText: proxied.statusText,
    headers: new Headers(proxied.headers),
  });
}
