import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_TTYD_RELAY_WS_QUERY_PARAM,
  buildBridgeTtydProxyUrl,
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

test("injectBridgeTtydRelayShim rewrites ttyd websocket connects through relay", () => {
  const html = "<html><head><script src=\"/refresh.js\"></script></head><body><script>console.log('ttyd');</script></body></html>";
  const injected = injectBridgeTtydRelayShim(
    html,
    "wss://relay.example.com/terminal/abc/browser?jwt=test",
  );

  assert.match(injected, /conductor-bridge-ttyd-relay-shim/);
  assert.match(injected, /RELAY_TTYD_WS_URL/);
  assert.match(injected, /REQUEST_MESSAGE_TYPE = 'conductor-ttyd-auth-token-request'/);
  assert.match(injected, /TOKEN_REQUEST_THROTTLE_MS = 1500/);
  assert.match(injected, /LOOPBACK_HOSTS/);
  assert.match(injected, /candidate\.hostname/);
  assert.match(injected, /candidate\.pathname === '\/'/);
  assert.match(injected, /candidate\.pathname === '\/ws'/);
  assert.match(injected, /candidate\.pathname\.endsWith\('\/ws'\)/);
  assert.match(injected, /normalizedUrl = RELAY_TTYD_WS_URL/);
  assert.match(injected, /requestFreshRelay\('bridge-websocket-close'\)/);
  assert.match(injected, /requestFreshRelay\('bridge-websocket-error'\)/);
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
