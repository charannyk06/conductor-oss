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

function buildBridgeTtydProxyPath(
  routeSessionId: string,
  bridgeId: string,
  relayTtydWsUrl?: string,
): string {
  const url = new URL(`/api/sessions/${encodeURIComponent(routeSessionId)}/terminal/ttyd`, "http://dashboard.local");
  url.searchParams.set("bridgeId", bridgeId);
  if (relayTtydWsUrl) {
    url.searchParams.set(BRIDGE_TTYD_RELAY_WS_QUERY_PARAM, relayTtydWsUrl);
  }
  return `${url.pathname}${url.search}`;
}

export function buildBridgeTtydProxyUrl(
  routeSessionId: string,
  bridgeId: string,
  relayTtydWsUrl: string,
): string {
  return buildBridgeTtydProxyPath(routeSessionId, bridgeId, relayTtydWsUrl);
}

export function buildStableBridgeTtydProxyUrl(
  routeSessionId: string,
  bridgeId: string,
): string {
  return buildBridgeTtydProxyPath(routeSessionId, bridgeId);
}

const PATCHED_TTYD_RESPONSE_HEADERS_TO_DROP = [
  "content-length",
  "content-encoding",
  "etag",
  "last-modified",
  "transfer-encoding",
] as const;

export function buildPatchedTtydHtmlResponse(proxied: Response, html: string): Response {
  const headers = new Headers(proxied.headers);
  for (const headerName of PATCHED_TTYD_RESPONSE_HEADERS_TO_DROP) {
    headers.delete(headerName);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");

  const body = new TextEncoder().encode(html);
  return new Response(body, {
    status: proxied.status,
    statusText: proxied.statusText,
    headers,
  });
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
 *
 * `dispatchResize` preserves xterm scroll position (or stick-to-bottom), matching
 * `TTYD_RESIZE_SHIM` in `crates/conductor-server/src/routes/terminal.rs`.
 */
export function injectTtydResizeShim(html: string): string {
  const marker = "conductor-ttyd-resize-shim";
  if (html.includes(marker)) {
    return html;
  }

  const fragment = `<!-- ${marker} -->
<script>
(function() {
  if (window.__conductorTtydResizeShimInstalled || window.__conductorTtydResizeShimPatched) return;
  window.__conductorTtydResizeShimInstalled = true;
  window.__conductorTtydResizeShimPatched = true;

  var RESIZE_MESSAGE_TYPE = "conductor-terminal-resize";
  var pendingRaf = null;
  var pendingBurstRaf = null;
  var burstTimers = [];

  function clearBurstTimers() {
    if (pendingBurstRaf !== null) {
      window.cancelAnimationFrame(pendingBurstRaf);
      pendingBurstRaf = null;
    }
    for (var i = 0; i < burstTimers.length; i++) {
      window.clearTimeout(burstTimers[i]);
    }
    burstTimers = [];
  }

  function findXtermScrollHost() {
    return document.querySelector(".xterm-viewport")
      || document.querySelector(".xterm-scrollable-element");
  }

  function findXtermTerminal() {
    if (typeof window !== "undefined" && window.ttyd && window.ttyd.terminal) return window.ttyd.terminal;
    if (typeof window !== "undefined" && window.term) return window.term;
    var container = document.querySelector(".terminal");
    if (container && container._xterm) return container._xterm;
    var termEl = document.querySelector(".xterm");
    if (termEl && termEl.__xterm) return termEl.__xterm;
    return null;
  }

  function queueXtermFit() {
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

  function dispatchResize() {
    var scrollHost = findXtermScrollHost();
    if (!scrollHost) {
      window.dispatchEvent(new Event("resize"));
      queueXtermFit();
      return;
    }

    var maxScroll = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
    var atBottom = maxScroll <= 0 || maxScroll - scrollHost.scrollTop < 12;
    var scrollRatio = maxScroll > 0 ? scrollHost.scrollTop / maxScroll : 1;

    window.dispatchEvent(new Event("resize"));

    function restore() {
      var sh = findXtermScrollHost();
      if (!sh) return;
      var newMax = Math.max(0, sh.scrollHeight - sh.clientHeight);
      if (newMax <= 0) return;
      if (atBottom) {
        sh.scrollTop = newMax;
      } else {
        sh.scrollTop = Math.round(scrollRatio * newMax);
      }
      queueXtermFit();
    }
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function() {
        window.requestAnimationFrame(restore);
      });
    } else {
      restore();
    }
  }

  function scheduleResizeBurst() {
    clearBurstTimers();
    if (typeof window.requestAnimationFrame === "function") {
      pendingBurstRaf = window.requestAnimationFrame(function() {
        pendingBurstRaf = null;
        dispatchResize();
      });
    } else {
      dispatchResize();
    }
    burstTimers.push(window.setTimeout(dispatchResize, 120));
    burstTimers.push(window.setTimeout(dispatchResize, 360));
  }

  function handleResizeMessage(event) {
    if (!event || !event.data) return;
    if (event.data.type !== RESIZE_MESSAGE_TYPE) return;

    var vw = Math.max(0, window.innerWidth || 0);
    var vh = Math.max(0, window.innerHeight || 0);
    if (vw < 10 || vh < 10) return;

    scheduleResizeBurst();
    queueXtermFit();
  }

  var lastViewportKey = "";
  function syncViewportSizeEmbedded() {
    var width = Math.max(0, Math.round(window.innerWidth || 0));
    var height = Math.max(0, Math.round(window.innerHeight || 0));
    var dpr = window.devicePixelRatio || 1;
    if (width < 10 || height < 10) return;
    var key = width + ":" + height + ":" + dpr;
    if (key === lastViewportKey) return;
    lastViewportKey = key;
    scheduleResizeBurst();
    queueXtermFit();
  }

  var viewportObserver = typeof ResizeObserver !== "undefined" && document.documentElement
    ? new ResizeObserver(syncViewportSizeEmbedded)
    : null;
  if (viewportObserver) {
    viewportObserver.observe(document.documentElement);
    if (document.body && document.body !== document.documentElement) {
      viewportObserver.observe(document.body);
    }
  }
  window.addEventListener("resize", syncViewportSizeEmbedded);
  window.addEventListener("orientationchange", syncViewportSizeEmbedded);
  window.addEventListener("pageshow", scheduleResizeBurst);
  window.addEventListener("focus", scheduleResizeBurst);
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "visible") {
      scheduleResizeBurst();
      queueXtermFit();
    }
  });
  if (document.fonts && document.fonts.ready) {
    void document.fonts.ready.then(function() { scheduleResizeBurst(); queueXtermFit(); }).catch(function() {});
  }
  syncViewportSizeEmbedded();
  // Match TTYD_RESIZE_SHIM boot in terminal.rs (initial sync + scheduleResizeBurst).
  scheduleResizeBurst();

  window.addEventListener("message", handleResizeMessage, false);

  window.addEventListener('beforeunload', function(e) {
    e.stopImmediatePropagation();
  }, true);

  window.addEventListener("beforeunload", function() {
    clearBurstTimers();
    if (viewportObserver) viewportObserver.disconnect();
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

  const REQUEST_MESSAGE_TYPE = 'conductor-ttyd-auth-token-request';
  const READY_MESSAGE_TYPE = 'conductor-ttyd-ready';
  const RELAY_UPDATE_MESSAGE_TYPE = 'conductor-ttyd-relay-url';
  const TOKEN_REQUEST_THROTTLE_MS = 1500;
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  const previousWebSocket = window.WebSocket;
  if (typeof previousWebSocket !== 'function') return;

  let currentRelayTtydWsUrl = ${relayWsLiteral};
  if (!currentRelayTtydWsUrl) return;

  let lastTokenRequestAt = 0;
  let unloading = false;

  function notifyReady() {
    if (unloading || !window.parent || window.parent === window) return;
    try {
      window.parent.postMessage({ type: READY_MESSAGE_TYPE }, '*');
    } catch {
    }
  }

  function requestFreshRelay(reason) {
    if (unloading || !window.parent || window.parent === window) return;

    const now = Date.now();
    if (now - lastTokenRequestAt < TOKEN_REQUEST_THROTTLE_MS) return;
    lastTokenRequestAt = now;

    try {
      window.parent.postMessage({
        type: REQUEST_MESSAGE_TYPE,
        reason,
      }, '*');
    } catch {
    }
  }

  function attachSocketListeners(socket) {
    if (!socket || socket.__conductorTokenRefreshHookAttached) return socket;

    socket.__conductorTokenRefreshHookAttached = true;
    socket.addEventListener('open', function() {
      notifyReady();
    });
    socket.addEventListener('close', function() {
      requestFreshRelay('bridge-websocket-close');
    });
    socket.addEventListener('error', function() {
      requestFreshRelay('bridge-websocket-error');
    });
    return socket;
  }

  function normalizedRelayUrl(url) {
    let normalizedUrl = String(url);
    try {
      const candidate = new URL(normalizedUrl, window.location.href);
      if (
        LOOPBACK_HOSTS.has(candidate.hostname) ||
        candidate.pathname === '/' ||
        candidate.pathname === '/ws' ||
        candidate.pathname.endsWith('/ws')
      ) {
        normalizedUrl = currentRelayTtydWsUrl;
      }
    } catch {
    }
    return normalizedUrl;
  }

  const patchedWebSocket = function(url, protocols) {
    const normalizedUrl = normalizedRelayUrl(url);
    if (arguments.length > 1) {
      return attachSocketListeners(new previousWebSocket(normalizedUrl, protocols));
    }
    return attachSocketListeners(new previousWebSocket(normalizedUrl));
  };

  Object.setPrototypeOf(patchedWebSocket, previousWebSocket);
  patchedWebSocket.prototype = previousWebSocket.prototype;
  window.WebSocket = patchedWebSocket;

  const trustedParentOrigin = window.location.origin;

  function handleMessage(event) {
    if (event.source !== window.parent || event.origin !== trustedParentOrigin) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== RELAY_UPDATE_MESSAGE_TYPE) {
      return;
    }
    const nextRelayUrl = typeof data.relayTtydWsUrl === 'string' ? data.relayTtydWsUrl.trim() : '';
    if (!nextRelayUrl) {
      return;
    }
    currentRelayTtydWsUrl = nextRelayUrl;
  }

  window.addEventListener('message', handleMessage);
  window.addEventListener('beforeunload', function() {
    unloading = true;
    window.removeEventListener('message', handleMessage);
  }, { once: true });
})();
</script>`;

  return injectBridgeTtydHtmlFragmentEarly(html, marker, fragment);
}
