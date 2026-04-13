import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TTYD_FRONTEND_PATH = join(
  MODULE_DIRECTORY,
  "ttyd_frontend_v1.7.7.html",
);

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

  cachedBundledTtydFrontendHtml = readFileSync(BUNDLED_TTYD_FRONTEND_PATH, "utf8");
  return cachedBundledTtydFrontendHtml;
}

export function buildBundledTtydHtmlResponse(html: string): Response {
  return new Response(new TextEncoder().encode(html), {
    status: 200,
    headers: BUNDLED_TTYD_RESPONSE_HEADERS,
  });
}
