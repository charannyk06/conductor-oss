import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  assertSafeDirectNavigationTarget,
  buildPinnedRequestOptions,
  buildPreviewNavigationCandidates,
  isLocalHost,
  isPrivateNetworkHostname,
  normalizeNavigationHostname,
  normalizeNavigationInput,
  requestSafeDirectNavigation,
  resolveSafeDirectNavigationTarget,
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
  assert.equal(isPrivateNetworkHostname("ff02::1"), true);
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
  await assertSafeDirectNavigationTarget("http://example.com/", {
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
  });
});

test("direct navigation pins the validated address used by the connection", async () => {
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

test("direct navigation rejects mixed public and private DNS answers", async () => {
  await assert.rejects(
    () => resolveSafeDirectNavigationTarget("https://preview.example/app", {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    }),
    /private network address/,
  );
});

test("the controlled direct request returns redirects for browser-side revalidation", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: "http://10.0.0.1/private" });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await requestSafeDirectNavigation({
      url: `http://127.0.0.1:${address.port}/redirect`,
      method: "GET",
      headers: {},
      body: null,
      timeoutMs: 1_000,
      allowLoopback: true,
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.location, "http://10.0.0.1/private");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("the controlled direct request enforces the session aggregate byte reservation while streaming", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.alloc(16 * 1024, 7));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let reserved = 0;
    await assert.rejects(
      requestSafeDirectNavigation({
        url: `http://127.0.0.1:${address.port}/large`,
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 1_000,
        allowLoopback: true,
        reserveBufferedBytes: (bytes) => {
          reserved += bytes;
          if (reserved > 1_024) {
            throw new Error("session aggregate byte budget exceeded");
          }
        },
      }),
      /session aggregate byte budget exceeded/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("the controlled direct request enforces an absolute deadline against slow-drip responses", async () => {
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
    const startedAt = Date.now();
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
    assert.ok(Date.now() - startedAt < 1_000, "a continuously active socket must still expire");
  } finally {
    for (const interval of intervals) clearInterval(interval);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});


test("resolvePreviewNavigationMode keeps allowed bridge origins on the relay path", () => {
  const bridgePreview = {
    allowedOrigins: ["http://127.0.0.1:3000"],
  };

  assert.equal(resolvePreviewNavigationMode("http://127.0.0.1:3000/", bridgePreview), "bridge");
  assert.equal(resolvePreviewNavigationMode("https://preview.example.com/app", bridgePreview), "direct");
  assert.equal(resolvePreviewNavigationMode("http://localhost:3000/", bridgePreview), "blocked");
});
