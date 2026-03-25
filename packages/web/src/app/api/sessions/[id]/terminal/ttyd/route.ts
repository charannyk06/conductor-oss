import { guardApiAccess } from "@/lib/auth";
import { guardAndProxy } from "@/lib/guardedRustProxy";
import { proxyToBridgeDevice } from "@/lib/bridgeApiProxy";
import {
  BRIDGE_TTYD_RELAY_WS_QUERY_PARAM,
  createBridgeTtydRelayWebSocketUrl,
  injectBridgeTtydRelayShim,
  resolveBridgeSessionTarget,
} from "@/lib/bridgeTtyd";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const target = resolveBridgeSessionTarget(id, request);
  if (!target) {
    return guardAndProxy(
      request,
      `/api/sessions/${encodeURIComponent(id ?? "")}/terminal/ttyd`,
      { role: "viewer" },
    );
  }

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

  const html = await proxied.text();
  return new Response(injectBridgeTtydRelayShim(html, relayTtydWsUrl), {
    status: proxied.status,
    statusText: proxied.statusText,
    headers: new Headers(proxied.headers),
  });
}
