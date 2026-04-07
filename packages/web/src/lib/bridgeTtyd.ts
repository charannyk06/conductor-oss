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

function injectBridgeTtydHtmlFragmentEarly(html: string, marker: string, fragment: string): string {
  if (html.includes(marker)) {
    return html;
  }

  const headOpenIndex = html.indexOf("<head");
  if (headOpenIndex >= 0) {
    const headCloseIndex = html.indexOf(">", headOpenIndex);
    if (headCloseIndex >= 0) {
      return `${html.slice(0, headCloseIndex + 1)}${fragment}${html.slice(headCloseIndex + 1)}`;
    }
  }

  const scriptOpenIndex = html.indexOf("<script");
  if (scriptOpenIndex >= 0) {
    return `${html.slice(0, scriptOpenIndex)}${fragment}${html.slice(scriptOpenIndex)}`;
  }

  return injectBridgeTtydHtmlFragment(html, marker, fragment);
}

function injectBridgeTtydHtmlFragment(html: string, marker: string, fragment: string): string {
  if (html.includes(marker)) {
    return html;
  }

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
  tunnelUrl?: unknown;
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

/**
 * Inject a resize coordination shim into the proxied ttyd HTML.
 *
 * The shim listens for a `conductor-terminal-resize` postMessage from the
 * parent frame. When received, it dispatches a synthetic `resize` event so
 * that ttyd's internal xterm.js FitAddon re-fits the terminal. This mirrors
 * the approach used in the Rust backend's TTYD_RESIZE_SHIM but is needed for
 * the bridge (proxied) path where the Rust shim is not injected.
 *
 * Additionally, it attempts a direct xterm fit+refresh if the terminal
 * instance can be located, providing a belt-and-suspenders approach.
 */
export function injectTtydResizeShim(html: string): string {
  const marker = "conductor-ttyd-resize-shim";
  if (html.includes(marker)) {
    return html;
  }

  const fragment = `<!-- ${marker} -->
<script>
(function() {
  if (window.__conductorTtydResizeShimPatched) return;
  window.__conductorTtydResizeShimPatched = true;

  var RESIZE_MESSAGE_TYPE = "conductor-terminal-resize";
  var pendingRaf = null;
  var burstTimers = [];

  function clearBurstTimers() {
    for (var i = 0; i < burstTimers.length; i++) {
      window.clearTimeout(burstTimers[i]);
    }
    burstTimers = [];
  }

  function dispatchResize() {
    window.dispatchEvent(new Event("resize"));
  }

  function scheduleResizeBurst() {
    clearBurstTimers();
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(dispatchResize);
    } else {
      dispatchResize();
    }
    burstTimers.push(window.setTimeout(dispatchResize, 120));
    burstTimers.push(window.setTimeout(dispatchResize, 360));
  }

  function findXtermTerminal() {
    if (typeof ttyd !== "undefined" && ttyd.terminal) return ttyd.terminal;
    var container = document.querySelector(".terminal");
    if (container && container._xterm) return container._xterm;
    var termEl = document.querySelector(".xterm");
    if (termEl && termEl.__xterm) return termEl.__xterm;
    return null;
  }

  function handleResizeMessage(event) {
    if (!event || !event.data) return;
    if (event.data.type !== RESIZE_MESSAGE_TYPE) return;

    // Guard: skip if viewport has collapsed to near-zero (tab switch, minimize).
    var vw = Math.max(0, window.innerWidth || 0);
    var vh = Math.max(0, window.innerHeight || 0);
    if (vw < 10 || vh < 10) return;

    // Primary: dispatch synthetic resize events so ttyd's FitAddon re-fits.
    // This mirrors the Rust backend shim's scheduleResizeBurst pattern.
    scheduleResizeBurst();

    // Secondary: direct xterm fit+refresh if we can find the instance.
    if (pendingRaf !== null) return;
    pendingRaf = requestAnimationFrame(function() {
      pendingRaf = null;
      var terminal = findXtermTerminal();
      if (!terminal) return;
      if (terminal._fitAddon) {
        try { terminal._fitAddon.fit(); } catch(e) {}
      }
      try {
        var rows = terminal.rows;
        if (rows > 0) terminal.refresh(0, rows - 1);
      } catch(e) {}
    });
  }

  window.addEventListener("message", handleResizeMessage, false);

  // Neutralize ttyd's built-in beforeunload handler that warns about leaving
  // the page. When embedded in the Conductor dashboard iframe, this dialog
  // is confusing and unnecessary since the terminal session persists.
  window.addEventListener('beforeunload', function(e) {
    e.stopImmediatePropagation();
  }, true);

  window.addEventListener("beforeunload", function() {
    clearBurstTimers();
  }, { once: true });
})();
</script>`;

  return injectBridgeTtydHtmlFragmentEarly(html, marker, fragment);
}

export function injectBridgeTtydRelayShim(html: string, relayTtydWsUrl: string): string {
  const marker = "conductor-bridge-ttyd-relay-shim";
  if (html.includes(marker)) {
    return html;
  }

  const relayWsLiteral = JSON.stringify(relayTtydWsUrl);
  const fragment = `<!-- ${marker} -->
<script>
(function() {
  if (window.__conductorBridgeTtydRelayPatched) return;
  window.__conductorBridgeTtydRelayPatched = true;

  const RELAY_TTYD_WS_URL = ${relayWsLiteral};
  if (!RELAY_TTYD_WS_URL) return;

  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  const previousWebSocket = window.WebSocket;
  if (typeof previousWebSocket !== 'function') return;

  const patchedWebSocket = function(url, protocols) {
    let normalizedUrl = String(url);
    try {
      const candidate = new URL(normalizedUrl, window.location.href);
      if (
        LOOPBACK_HOSTS.has(candidate.hostname) ||
        candidate.pathname === '/' ||
        candidate.pathname === '/ws' ||
        candidate.pathname.endsWith('/ws')
      ) {
        normalizedUrl = RELAY_TTYD_WS_URL;
      }
    } catch {
    }

    if (arguments.length > 1) {
      return new previousWebSocket(normalizedUrl, protocols);
    }
    return new previousWebSocket(normalizedUrl);
  };

  Object.setPrototypeOf(patchedWebSocket, previousWebSocket);
  patchedWebSocket.prototype = previousWebSocket.prototype;
  window.WebSocket = patchedWebSocket;
})();
</script>`;

  return injectBridgeTtydHtmlFragmentEarly(html, marker, fragment);
}
