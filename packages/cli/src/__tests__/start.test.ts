import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteUnlockUrl,
  extractCloudflareTunnelUrl,
  isLoopbackHost,
} from "../commands/start.js";

test("extractCloudflareTunnelUrl reads the quick tunnel URL from cloudflared logs", () => {
  const output = [
    "INF Requesting new quick Tunnel on trycloudflare.com...",
    "INF +--------------------------------------------------------------------------------------------+",
    "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |",
    "INF |  https://fancy-space-1234.trycloudflare.com                                               |",
    "INF +--------------------------------------------------------------------------------------------+",
  ].join("\n");

  assert.equal(
    extractCloudflareTunnelUrl(output),
    "https://fancy-space-1234.trycloudflare.com",
  );
});

test("extractCloudflareTunnelUrl returns null when no URL is present", () => {
  assert.equal(extractCloudflareTunnelUrl("no tunnel yet"), null);
});

test("buildRemoteUnlockUrl points at the built-in unlock route", () => {
  assert.equal(
    buildRemoteUnlockUrl("https://fancy-space-1234.trycloudflare.com", "secret-token"),
    "https://fancy-space-1234.trycloudflare.com/unlock#token=secret-token",
  );
});

test("isLoopbackHost recognizes local-only bind hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});
