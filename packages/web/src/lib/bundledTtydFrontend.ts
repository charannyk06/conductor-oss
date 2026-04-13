import { readFileSync } from "node:fs";

const BUNDLED_TTYD_FRONTEND_URL = new URL("./ttyd_frontend_v1.7.7.html", import.meta.url);

const BUNDLED_TTYD_RESPONSE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-disposition": "inline; filename=ttyd.html",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
} as const;

let cachedBundledTtydFrontendHtml: string | null = null;

export function loadBundledTtydFrontendHtml(): string {
  if (cachedBundledTtydFrontendHtml !== null) {
    return cachedBundledTtydFrontendHtml;
  }

  cachedBundledTtydFrontendHtml = readFileSync(BUNDLED_TTYD_FRONTEND_URL, "utf8");
  return cachedBundledTtydFrontendHtml;
}

export function buildBundledTtydHtmlResponse(html: string): Response {
  return new Response(new TextEncoder().encode(html), {
    status: 200,
    headers: BUNDLED_TTYD_RESPONSE_HEADERS,
  });
}
