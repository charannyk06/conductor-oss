import { NextResponse } from "next/server";
import { getDashboardAccess, guardApiAccess } from "@/lib/auth";
import {
  buildBridgeRelayAuthHeaders,
  buildBridgeRelayWebSocketUrl,
  resolveBridgeRelayUserId,
  signBridgeRelayJwt,
} from "@/lib/bridgeRelayAuth";
import { getBridgeIdFromRequest, proxyToBridgeDevice } from "@/lib/bridgeApiProxy";
import { requireBridgeRelayUrl } from "@/lib/bridgeRelayUrl";
import { decodeBridgeSessionId } from "@/lib/bridgeSessionIds";

export const BRIDGE_TTYD_RELAY_WS_QUERY_PARAM = "relayTtydWs";

export type BridgeSessionTarget = {
  bridgeId: string;
  sessionId: string;
};

export function resolveBridgeSessionTarget(
  routeSessionId: string,
  request: Request,
): BridgeSessionTarget | null {
  const bridgeSession = decodeBridgeSessionId(routeSessionId);
  if (bridgeSession) {
    return bridgeSession;
  }

  const bridgeId = getBridgeIdFromRequest(request);
  const sessionId = routeSessionId.trim();
  if (!bridgeId || sessionId.length === 0) {
    return null;
  }

  return { bridgeId, sessionId };
}

export function buildBridgeTtydProxyUrl(
  routeSessionId: string,
  bridgeId: string,
  relayTtydWsUrl: string,
): string {
  const url = new URL(`/api/sessions/${encodeURIComponent(routeSessionId)}/terminal/ttyd`, "http://dashboard.local");
  url.searchParams.set("bridgeId", bridgeId);
  url.searchParams.set(BRIDGE_TTYD_RELAY_WS_QUERY_PARAM, relayTtydWsUrl);
  return `${url.pathname}${url.search}`;
}

export async function createBridgeTtydRelayWebSocketUrl(
  request: Request,
  bridgeId: string,
  sessionId: string,
): Promise<string> {
  const access = await getDashboardAccess(request);
  const userId = resolveBridgeRelayUserId(access);
  if (!userId) {
    throw new Error("Unable to resolve the dashboard user for the bridge relay.");
  }

  const relayTarget = new URL(
    `/api/devices/${encodeURIComponent(bridgeId)}/terminals`,
    requireBridgeRelayUrl(),
  );
  const relayResponse = await fetch(relayTarget, {
    method: "POST",
    headers: new Headers({
      ...(Object.fromEntries((await buildBridgeRelayAuthHeaders(request)).entries())),
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ session_id: sessionId }),
    cache: "no-store",
    redirect: "manual",
  });

  const payload = (await relayResponse.json().catch(() => null)) as
    | { terminal_id?: string; error?: string }
    | null;
  if (!relayResponse.ok || !payload?.terminal_id) {
    throw new Error(
      payload?.error ?? `Failed to create relay terminal session (${relayResponse.status})`,
    );
  }

  const jwt = await signBridgeRelayJwt(userId, "terminal-browser", "12h");
  return buildBridgeRelayWebSocketUrl(
    `/terminal/${encodeURIComponent(payload.terminal_id)}/browser`,
    jwt,
  );
}

type TerminalTokenPayload = {
  required?: unknown;
  expiresInSeconds?: unknown;
  ttydHttpUrl?: unknown;
  ttydWsUrl?: unknown;
  error?: unknown;
};

export async function ensureBridgeTtydSession(
  request: Request,
  routeSessionId: string,
  minimumRole: "viewer" | "operator",
): Promise<
  | {
      ok: true;
      bridgeId: string;
      sessionId: string;
      routeSessionId: string;
      upstreamPayload: TerminalTokenPayload | null;
      relayTtydWsUrl: string;
    }
  | { ok: false; response: Response }
> {
  const denied = await guardApiAccess(request, minimumRole);
  if (denied) {
    return { ok: false, response: denied };
  }

  const target = resolveBridgeSessionTarget(routeSessionId, request);
  if (!target) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Paired device required" },
        { status: 412 },
      ),
    };
  }

  const upstreamTokenResponse = await proxyToBridgeDevice(
    request,
    target.bridgeId,
    `/api/sessions/${encodeURIComponent(target.sessionId)}/terminal/token`,
    {
      pathOverride: `/api/sessions/${encodeURIComponent(target.sessionId)}/terminal/token`,
    },
  );

  if (!upstreamTokenResponse.ok) {
    return { ok: false, response: upstreamTokenResponse };
  }

  const upstreamPayload = (await upstreamTokenResponse.json().catch(() => null)) as TerminalTokenPayload | null;
  const hasTtyd = typeof upstreamPayload?.ttydHttpUrl === "string" || typeof upstreamPayload?.ttydWsUrl === "string";
  if (!hasTtyd) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: upstreamPayload?.error ?? `Session ${target.sessionId} does not expose a ttyd terminal` },
        { status: 409 },
      ),
    };
  }

  try {
    const relayTtydWsUrl = await createBridgeTtydRelayWebSocketUrl(
      request,
      target.bridgeId,
      target.sessionId,
    );
    return {
      ok: true,
      bridgeId: target.bridgeId,
      sessionId: target.sessionId,
      routeSessionId,
      upstreamPayload,
      relayTtydWsUrl,
    };
  } catch (error) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to connect relay ttyd session" },
        { status: 502 },
      ),
    };
  }
}

export function injectBridgeTtydRelayShim(html: string, relayTtydWsUrl: string): string {
  const marker = "conductor-bridge-ttyd-relay-shim";
  if (html.includes(marker)) {
    return html;
  }

  const relayWsLiteral = JSON.stringify(relayTtydWsUrl);
  const fragment = `<!-- ${marker} -->\n<script>\n(function() {\n  if (window.__conductorBridgeTtydRelayPatched) return;\n  window.__conductorBridgeTtydRelayPatched = true;\n\n  const RELAY_TTYD_WS_URL = ${relayWsLiteral};\n  if (!RELAY_TTYD_WS_URL) return;\n\n  const previousWebSocket = window.WebSocket;\n  if (typeof previousWebSocket !== 'function') return;\n\n  const patchedWebSocket = function(url, protocols) {\n    let normalizedUrl = String(url);\n    try {\n      const candidate = new URL(normalizedUrl, window.location.href);\n      if (candidate.pathname === '/ws' || candidate.pathname.endsWith('/ws')) {\n        normalizedUrl = RELAY_TTYD_WS_URL;\n      }\n    } catch {\n    }\n\n    if (arguments.length > 1) {\n      return new previousWebSocket(normalizedUrl, protocols);\n    }\n    return new previousWebSocket(normalizedUrl);\n  };\n\n  Object.setPrototypeOf(patchedWebSocket, previousWebSocket);\n  patchedWebSocket.prototype = previousWebSocket.prototype;\n  window.WebSocket = patchedWebSocket;\n})();\n</script>`;

  const bodyCloseIndex = html.lastIndexOf("</body>");
  if (bodyCloseIndex >= 0) {
    return `${html.slice(0, bodyCloseIndex)}${fragment}${html.slice(bodyCloseIndex)}`;
  }

  const htmlCloseIndex = html.lastIndexOf("</html>");
  if (htmlCloseIndex >= 0) {
    return `${html.slice(0, htmlCloseIndex)}${fragment}${html.slice(htmlCloseIndex)}`;
  }

  return `${html}${fragment}`;
}
