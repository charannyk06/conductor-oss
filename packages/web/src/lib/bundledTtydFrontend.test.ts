import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBundledTtydHtmlResponse,
  loadBundledTtydFrontendHtml,
} from "./bundledTtydFrontend";

test("loadBundledTtydFrontendHtml reads the vendored ttyd shell", () => {
  const html = loadBundledTtydFrontendHtml();

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /ttyd - Terminal/);
  assert.match(html, /\/token/);
  assert.match(html, /\/ws/);
});

test("buildBundledTtydHtmlResponse serves html with no-store headers", async () => {
  const response = buildBundledTtydHtmlResponse("<html><body>ok</body></html>");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), "inline; filename=ttyd.html");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate, max-age=0");
  assert.equal(await response.text(), "<html><body>ok</body></html>");
});
