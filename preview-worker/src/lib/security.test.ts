import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeDirectNavigationTarget,
  buildPreviewNavigationCandidates,
  isLocalHost,
  isPrivateNetworkHostname,
  normalizeNavigationHostname,
  normalizeNavigationInput,
  resolvePreviewNavigationMode,
} from "./security.js";

const env = process.env as Record<string, string | undefined>;
const previousUnsafe = env.CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS;

test.afterEach(() => {
  if (previousUnsafe === undefined) {
    delete env.CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS;
  } else {
    env.CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS = previousUnsafe;
  }
});

test("normalizeNavigationHostname strips bracketed IPv6", () => {
  assert.equal(normalizeNavigationHostname("[::1]"), "::1");
  assert.equal(normalizeNavigationHostname("LOCALHOST"), "localhost");
});

test("normalizeNavigationInput adds http for bare local hosts", () => {
  assert.equal(normalizeNavigationInput("  localhost:3000  "), "http://localhost:3000");
  assert.equal(normalizeNavigationInput("https://a.com/x"), "https://a.com/x");
  assert.equal(normalizeNavigationInput(""), "");
});

test("isLocalHost recognizes loopback names", () => {
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("example.com"), false);
});

test("isPrivateNetworkHostname covers RFC4193 ULA and link-local", () => {
  assert.equal(isPrivateNetworkHostname("fe80::1"), true);
  assert.equal(isPrivateNetworkHostname("fd12::1"), true);
  assert.equal(isPrivateNetworkHostname("2001:4860:4860::8888"), false);
});

test("buildPreviewNavigationCandidates expands loopback variants", () => {
  const urls = buildPreviewNavigationCandidates("http://127.0.0.1:4000/path");
  assert.ok(urls.length >= 2);
  assert.ok(urls.some((u) => u.includes("127.0.0.1")));
  assert.ok(urls.some((u) => u.includes("localhost")));
});

test("buildPreviewNavigationCandidates keeps public https urls as a single entry", () => {
  assert.deepEqual(buildPreviewNavigationCandidates("https://preview.example.com/app"), [
    "https://preview.example.com/app",
  ]);
});

test("buildPreviewNavigationCandidates rejects non-http schemes", () => {
  assert.throws(
    () => buildPreviewNavigationCandidates("javascript://evil/%0aalert(1)"),
    /only http and https URLs are allowed/,
  );
});

test("assertSafeDirectNavigationTarget allows loopback URLs", async () => {
  await assertSafeDirectNavigationTarget("http://127.0.0.1:8080/");
  await assertSafeDirectNavigationTarget("http://localhost:3000/");
});

test("assertSafeDirectNavigationTarget blocks literal private IPv4", async () => {
  await assert.rejects(
    () => assertSafeDirectNavigationTarget("http://192.168.1.10/"),
    /private network/,
  );
});

test("assertSafeDirectNavigationTarget skips checks when unsafe preview hosts are enabled", async () => {
  env.CONDUCTOR_ALLOW_UNSAFE_PREVIEW_HOSTS = "true";
  await assertSafeDirectNavigationTarget("http://10.0.0.1/");
});

test("assertSafeDirectNavigationTarget allows public http when DNS resolves to public addresses", async () => {
  await assertSafeDirectNavigationTarget("http://example.com/");
});


test("resolvePreviewNavigationMode keeps allowed bridge origins on the relay path", () => {
  const bridgePreview = {
    allowedOrigins: ["http://127.0.0.1:3000"],
  };

  assert.equal(resolvePreviewNavigationMode("http://127.0.0.1:3000/", bridgePreview), "bridge");
  assert.equal(resolvePreviewNavigationMode("https://preview.example.com/app", bridgePreview), "direct");
  assert.equal(resolvePreviewNavigationMode("http://localhost:3000/", bridgePreview), "blocked");
});
