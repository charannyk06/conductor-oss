import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_TTYD_RELAY_WS_QUERY_PARAM,
  buildBridgeTtydProxyUrl,
  buildPatchedTtydHtmlResponse,
  buildStableBridgeTtydProxyUrl,
  injectBridgeTtydRelayShim,
  injectTtydResizeShim,
} from "./bridgeTtyd";

test("buildBridgeTtydProxyUrl preserves session scope and relay ttyd ws", () => {
  const url = buildBridgeTtydProxyUrl(
    "bridge:device-1:session-9",
    "device-1",
    "wss://relay.example.com/terminal/abc/browser?jwt=test",
  );

  const resolved = new URL(url, "https://app.conductross.com");
  assert.equal(resolved.pathname, "/api/sessions/bridge%3Adevice-1%3Asession-9/terminal/ttyd");
  assert.equal(resolved.searchParams.get("bridgeId"), "device-1");
  assert.equal(
    resolved.searchParams.get(BRIDGE_TTYD_RELAY_WS_QUERY_PARAM),
    "wss://relay.example.com/terminal/abc/browser?jwt=test",
  );
});

test("buildStableBridgeTtydProxyUrl keeps the iframe url stable across relay refreshes", () => {
  const url = buildStableBridgeTtydProxyUrl(
    "bridge:device-1:session-9",
    "device-1",
  );

  const resolved = new URL(url, "https://app.conductross.com");
  assert.equal(resolved.pathname, "/api/sessions/bridge%3Adevice-1%3Asession-9/terminal/ttyd");
  assert.equal(resolved.searchParams.get("bridgeId"), "device-1");
  assert.equal(resolved.searchParams.get(BRIDGE_TTYD_RELAY_WS_QUERY_PARAM), null);
});

test("injectBridgeTtydRelayShim rewrites ttyd websocket connects through relay", () => {
  const html = "<html><head><script src=\"/refresh.js\"></script></head><body><script>console.log('ttyd');</script></body></html>";
  const injected = injectBridgeTtydRelayShim(
    html,
    "wss://relay.example.com/terminal/abc/browser?jwt=test",
  );

  assert.match(injected, /conductor-bridge-ttyd-relay-shim/);
  assert.match(injected, /currentRelayTtydWsUrl/);
  assert.match(injected, /REQUEST_MESSAGE_TYPE = 'conductor-ttyd-auth-token-request'/);
  assert.match(injected, /TOKEN_REQUEST_THROTTLE_MS/);
  assert.match(injected, /LOOPBACK_HOSTS/);

  assert.match(injected, /candidate\.pathname === '\/'/);
  assert.match(injected, /candidate\.pathname === '\/ws'/);
  assert.match(injected, /candidate\.pathname\.endsWith\('\/ws'\)/);
  assert.match(injected, /normalizedUrl = currentRelayTtydWsUrl/);
  assert.match(injected, /requestFreshRelay\('bridge-websocket-close'\)/);
  assert.match(injected, /requestFreshRelay\('bridge-websocket-error'\)/);
  assert.match(injected, /READY_MESSAGE_TYPE = 'conductor-ttyd-ready'/);
  assert.match(injected, /RELAY_UPDATE_MESSAGE_TYPE = 'conductor-ttyd-relay-url'/);
  assert.match(injected, /window\.parent\.postMessage\(\{ type: READY_MESSAGE_TYPE \}, '\*'\)/);
  assert.match(injected, /const trustedParentOrigin = window\.location\.origin/);
  assert.match(injected, /event\.origin !== trustedParentOrigin/);
  assert.match(injected, /currentRelayTtydWsUrl = nextRelayUrl/);
  assert.ok(
    injected.indexOf("conductor-bridge-ttyd-relay-shim") < injected.indexOf("<script src=\"/refresh.js\">"),
    "relay shim should be injected before ttyd bootstrap scripts",
  );
});

test("injectTtydResizeShim matches backend ttyd scroll-preservation resize behavior", () => {
  const html = "<html><body></body></html>";
  const injected = injectTtydResizeShim(html);
  assert.match(injected, /findXtermScrollHost/);
  assert.match(injected, /conductor-terminal-resize/);
  assert.match(
    injected,
    /syncViewportSizeEmbedded\(\);\s*\/\/ Match TTYD_RESIZE_SHIM boot/,
    "initial sync should be followed by a resize burst like terminal.rs",
  );
});

test("buildPatchedTtydHtmlResponse drops stale body headers after html injection", async () => {
  const proxied = new Response("<html><body>old</body></html>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": "123",
      "content-encoding": "gzip",
      etag: '"abc123"',
      "cache-control": "no-store",
    },
  });

  const patched = buildPatchedTtydHtmlResponse(proxied, "<html><body>new</body></html>");

  assert.equal(patched.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(patched.headers.get("content-length"), null);
  assert.equal(patched.headers.get("content-encoding"), null);
  assert.equal(patched.headers.get("etag"), null);
  assert.equal(
    patched.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate, max-age=0",
  );
  assert.equal(patched.headers.get("pragma"), "no-cache");
  assert.equal(patched.headers.get("expires"), "0");
  assert.equal(await patched.text(), "<html><body>new</body></html>");
});

test("buildPatchedTtydHtmlResponse forces html rendering headers for patched ttyd pages", async () => {
  const proxied = new Response("<html><body>old</body></html>", {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="ttyd"',
    },
  });

  const patched = buildPatchedTtydHtmlResponse(proxied, "<html><body>new</body></html>");

  assert.equal(patched.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(patched.headers.get("content-disposition"), null);
  assert.equal(await patched.text(), "<html><body>new</body></html>");
});
