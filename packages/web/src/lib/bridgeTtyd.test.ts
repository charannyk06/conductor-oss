import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_TTYD_RELAY_WS_QUERY_PARAM,
  buildBridgeTtydProxyUrl,
  injectBridgeTtydRelayShim,
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
  const html = "<html><body><script>console.log('ttyd');</script></body></html>";
  const injected = injectBridgeTtydRelayShim(
    html,
    "wss://relay.example.com/terminal/abc/browser?jwt=test",
  );

  assert.match(injected, /conductor-bridge-ttyd-relay-shim/);
  assert.match(injected, /RELAY_TTYD_WS_URL/);
  assert.match(injected, /candidate\.pathname === '\/ws'/);
  assert.match(injected, /normalizedUrl = RELAY_TTYD_WS_URL/);
});
