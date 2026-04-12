import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { readTtydHtmlResponse } from "./ttydHtmlResponse";

test("readTtydHtmlResponse returns null when the proxied HTML stream errors", async () => {
  let failRead: (error: Error) => void = () => {};
  const proxied = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        failRead = (error) => controller.error(error);
      },
    }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );

  const readPromise = readTtydHtmlResponse(proxied);
  failRead(new Error("bridge stream failed"));

  const html = await readPromise;
  assert.equal(html, null);
});

test("readTtydHtmlResponse accepts the vendored ttyd frontend size used by the iframe proxy", async () => {
  const ttydFrontendPath = join(
    process.cwd(),
    "..",
    "..",
    "crates",
    "conductor-server",
    "src",
    "routes",
    "ttyd_frontend_v1.7.7.html",
  );
  const html = readFileSync(ttydFrontendPath, "utf8");
  const proxied = new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(html)),
    },
  });

  const resolved = await readTtydHtmlResponse(proxied);
  assert.equal(resolved, html);
});

test("readTtydHtmlResponse still rejects oversized ttyd HTML responses", async () => {
  const proxied = new Response("<html><body>large</body></html>", {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(9 * 1024 * 1024),
    },
  });

  await assert.rejects(
    () => readTtydHtmlResponse(proxied),
    /ttyd frontend response is too large/,
  );
});
