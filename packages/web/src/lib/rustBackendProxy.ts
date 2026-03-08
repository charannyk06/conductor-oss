import { NextResponse } from "next/server";

const backendUrl = process.env.CONDUCTOR_BACKEND_URL?.trim() ?? "";

const BLOCKED_REQUEST_HEADERS = new Set<string>([
  "connection",
  "host",
  "content-length",
  "expect",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailers",
  "transfer-encoding",
  "accept-encoding",
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "keep-alive",
  "transfer-encoding",
]);

export function hasRustBackend(): boolean {
  return backendUrl.length > 0;
}

export async function proxyToRust(request: Request, pathname: string): Promise<Response> {
  if (!hasRustBackend()) {
    throw new Error("Rust backend URL is not configured");
  }

  const incomingUrl = new URL(request.url);
  const target = new URL(pathname, backendUrl);
  target.search = incomingUrl.search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
  headers.set("x-forwarded-host", incomingUrl.host);

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    cache: "no-store",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  const response = await fetch(target, init);
  const responseHeaders = new Headers();
  response.headers.forEach((value, key) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function proxyToRustOrUnavailable(request: Request, pathname: string): Promise<Response> {
  if (!hasRustBackend()) {
    return NextResponse.json(
      { error: "Rust backend URL is not configured" },
      { status: 503 },
    );
  }

  try {
    return await proxyToRust(request, pathname);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reach Rust backend" },
      { status: 502 },
    );
  }
}
