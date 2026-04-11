import assert from "node:assert/strict";
import test from "node:test";

import { readTtydHtmlResponse } from "./ttydHtmlResponse";

test("readTtydHtmlResponse returns null when the proxied HTML stream errors", async () => {
  const proxied = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("bridge stream failed"));
      },
    }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );

  const html = await readTtydHtmlResponse(proxied);
  assert.equal(html, null);
});

test("readTtydHtmlResponse still rejects oversized ttyd HTML responses", async () => {
  const proxied = new Response("<html><body>large</body></html>", {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(600 * 1024),
    },
  });

  await assert.rejects(
    () => readTtydHtmlResponse(proxied),
    /ttyd frontend response is too large/,
  );
});
