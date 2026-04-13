import assert from "node:assert/strict";
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

test("readTtydHtmlResponse accepts large ttyd HTML responses up to the backend limit", async () => {
  const largeHtml = `<!DOCTYPE html><html><body>${"x".repeat(700 * 1024)}</body></html>`;
  const proxied = new Response(largeHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(largeHtml, "utf8")),
    },
  });

  const html = await readTtydHtmlResponse(proxied);
  assert.equal(html, largeHtml);
});

test("readTtydHtmlResponse unwraps bridge-proxied html JSON strings", async () => {
  const html = "<!DOCTYPE html><html><body>ttyd</body></html>";
  const proxied = new Response(JSON.stringify(html), {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });

  assert.equal(await readTtydHtmlResponse(proxied), html);
});

test("readTtydHtmlResponse accepts html bodies even when upstream headers look like downloads", async () => {
  const html = "<!DOCTYPE html><html><body>ttyd</body></html>";
  const proxied = new Response(html, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="ttyd"',
    },
  });

  assert.equal(await readTtydHtmlResponse(proxied), html);
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
