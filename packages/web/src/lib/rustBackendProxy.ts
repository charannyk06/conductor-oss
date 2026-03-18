import { NextResponse } from "next/server";
import { requireRustBackendUrl, resolveRustBackendUrl } from "./backendUrl";
const INTERNAL_ACCESS_HEADERS = [
  "x-conductor-proxy-authorized",
  "x-conductor-access-authenticated",
  "x-conductor-access-role",
  "x-conductor-access-email",
  "x-conductor-access-provider",
] as const;

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
  ...INTERNAL_ACCESS_HEADERS,
]);

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "keep-alive",
  "transfer-encoding",
]);

export function hasRustBackend(): boolean {
  return resolveRustBackendUrl() !== null;
}

type RustProxyOptions = {
  headers?: HeadersInit;
};

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

function isIgnorableStreamTermination(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: string;
    code?: string;
    message?: string;
    cause?: unknown;
  };

  if (candidate.name === "AbortError" || candidate.code === "UND_ERR_SOCKET") {
    return true;
  }

  if (candidate.message?.toLowerCase().includes("terminated")) {
    return true;
  }

  return candidate.cause ? isIgnorableStreamTermination(candidate.cause) : false;
}

function wrapEventStreamBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) {
    return null;
  }

  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (!isIgnorableStreamTermination(error)) {
          controller.error(error);
          return;
        }
        controller.close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Ignore cancellations from an already-closed upstream SSE socket.
      }
    },
  });
}

export async function proxyToRust(
  request: Request,
  pathname: string,
  options: RustProxyOptions = {},
): Promise<Response> {
  const backendUrl = requireRustBackendUrl();

  const incomingUrl = new URL(request.url);
  const target = new URL(pathname, backendUrl);
  target.search = incomingUrl.search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  if (options.headers) {
    const extraHeaders = new Headers(options.headers);
    extraHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  }
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

  return new Response(isEventStreamResponse(response) ? wrapEventStreamBody(response.body) : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function proxyToRustOrUnavailable(
  request: Request,
  pathname: string,
  options: RustProxyOptions = {},
): Promise<Response> {
  if (!hasRustBackend()) {
    return NextResponse.json(
      { error: "Rust backend URL is not configured" },
      { status: 503 },
    );
  }

  try {
    return await proxyToRust(request, pathname, options);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reach Rust backend" },
      { status: 502 },
    );
  }
}
