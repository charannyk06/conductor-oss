import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreviewNavigationCandidates,
  isPrivateNetworkHostname,
  resolvePreviewNavigationMode,
} from "./devPreviewBrowser";

test("buildPreviewNavigationCandidates expands localhost urls", () => {
  assert.deepEqual(buildPreviewNavigationCandidates("localhost:3000"), [
    "http://localhost:3000/",
    "http://127.0.0.1:3000/",
    "http://0.0.0.0:3000/",
  ]);
});

test("buildPreviewNavigationCandidates keeps remote http urls intact", () => {
  assert.deepEqual(buildPreviewNavigationCandidates("https://preview.example.com/app"), [
    "https://preview.example.com/app",
  ]);
});

test("buildPreviewNavigationCandidates rejects non-http schemes", () => {
  assert.throws(
    () => buildPreviewNavigationCandidates("javascript://localhost/%0aalert(1)"),
    /only http and https URLs are allowed/,
  );
});

test("resolvePreviewNavigationMode bridges allowed local origins and keeps remote urls direct", () => {
  const bridgePreview = {
    bridgeId: "bridge-1",
    sessionId: "session-1",
    allowedOrigins: ["http://127.0.0.1:3000"],
  };

  assert.equal(resolvePreviewNavigationMode("http://127.0.0.1:3000/", bridgePreview), "bridge");
  assert.equal(resolvePreviewNavigationMode("https://preview.example.com/app", bridgePreview), "direct");
  assert.equal(resolvePreviewNavigationMode("http://localhost:3000/", bridgePreview), "blocked");
});

test("isPrivateNetworkHostname blocks link-local ipv6 addresses", () => {
  assert.equal(isPrivateNetworkHostname("fe80::1"), true);
  assert.equal(isPrivateNetworkHostname("[fe80::1]"), true);
  assert.equal(isPrivateNetworkHostname("2001:4860:4860::8888"), false);
});
