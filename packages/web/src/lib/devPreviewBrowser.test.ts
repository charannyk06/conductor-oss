import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { Page } from "puppeteer-core";
import {
  MAX_BUFFERED_PREVIEW_BYTES,
  MAX_CONCURRENT_PREVIEW_REQUESTS,
  assertSafeDirectNavigationTarget,
  beginPreviewInterception,
  buildPinnedRequestOptions,
  buildPreviewNavigationCandidates,
  installPreviewBrowserNetworkGuard,
  isPrivateNetworkHostname,
  requestSafeDirectNavigation,
  retainDirectLoopbackOrigin,
  resolveSafeDirectNavigationTarget,
  resolvePreviewNavigationMode,
} from "./devPreviewBrowser";

test("browser network guard blocks WebSocket and non-HTTP network schemes below the page", async () => {
  const events = new EventEmitter();
  const commands: Array<{ method: string; params?: unknown }> = [];
  let blockedUrl: string | null = null;
  const page = {
    createCDPSession: async () => ({
      send: async (method: string, params?: unknown) => {
        commands.push({ method, params });
        return {};
      },
      on: (name: string, listener: (...args: unknown[]) => void) => events.on(name, listener),
      detach: async () => {},
    }),
  } as unknown as Page;

  await installPreviewBrowserNetworkGuard(page, (url) => {
    blockedUrl = url;
  });
  assert.deepEqual(commands.find((command) => command.method === "Network.setBlockedURLs")?.params, {
    urls: ["ws://*", "wss://*", "file://*", "ftp://*", "gopher://*"],
  });
  events.emit("Network.webSocketCreated", { url: "wss://example.com/socket" });
  assert.equal(blockedUrl, "wss://example.com/socket");
});

test("preview interception budget bounds concurrency and aggregate buffered bytes", () => {
  const budget = { activeRequests: 0, bufferedBytes: 0 };
  const reservations = Array.from(
    { length: MAX_CONCURRENT_PREVIEW_REQUESTS },
    () => beginPreviewInterception(budget),
  );
  assert.throws(() => beginPreviewInterception(budget), /concurrent network requests/);
  reservations.forEach((reservation) => reservation.finish());

  const reservation = beginPreviewInterception(budget);
  reservation.reserve(MAX_BUFFERED_PREVIEW_BYTES);
  assert.throws(() => reservation.reserve(1), /64 MiB buffered network-data limit/);
  reservation.finish();
  assert.deepEqual(budget, { activeRequests: 0, bufferedBytes: 0 });
  assert.throws(() => reservation.reserve(1), /already closed/);
});

test("loopback authorization is retained only for the same authorized loopback origin", () => {
  assert.equal(
    retainDirectLoopbackOrigin("http://localhost:3000", "http://localhost:3000/next", "direct"),
    "http://localhost:3000",
  );
  assert.equal(
    retainDirectLoopbackOrigin("http://localhost:3000", "https://public.example/app", "direct"),
    null,
  );
  assert.equal(
    retainDirectLoopbackOrigin(null, "http://localhost:3000/private", "direct"),
    null,
  );
});

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

test("assertSafeDirectNavigationTarget blocks private network requests", async () => {
  await assert.rejects(
    () => assertSafeDirectNavigationTarget("http://192.168.1.20/private"),
    /private network/,
  );
});

test("assertSafeDirectNavigationTarget allows public http requests", async () => {
  await assertSafeDirectNavigationTarget("https://preview.example.com/app", {
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
  });
});

test("direct preview requests connect to the address that passed validation", async () => {
  let lookups = 0;
  const target = await resolveSafeDirectNavigationTarget("https://preview.example/app", {
    resolver: async () => {
      lookups += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });
  const options = buildPinnedRequestOptions(target, "GET", {});

  assert.equal(lookups, 1);
  assert.equal(options.hostname, "93.184.216.34");
  assert.equal(options.servername, "preview.example");
  assert.equal((options.headers as Record<string, string>).host, "preview.example");
});

test("direct preview requests enforce an absolute deadline against slow-drip responses", async () => {
  const intervals = new Set<NodeJS.Timeout>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.from([1]));
    const interval = setInterval(() => response.write(Buffer.from([1])), 20);
    intervals.add(interval);
    response.once("close", () => {
      clearInterval(interval);
      intervals.delete(interval);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(
      requestSafeDirectNavigation({
        url: `http://127.0.0.1:${address.port}/drip`,
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 100,
        allowLoopback: true,
      }),
      /timed out/,
    );
  } finally {
    for (const interval of intervals) clearInterval(interval);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
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
  assert.equal(isPrivateNetworkHostname("ff02::1"), true);
  assert.equal(isPrivateNetworkHostname("2001:4860:4860::8888"), false);
});
