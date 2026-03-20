import type { DashboardRole } from "@conductor-oss/core/types";
import { NextRequest, NextResponse } from "next/server";
import { getDashboardAccess, guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";
import { requireBridgeRelayUrl, resolveBridgeRelayUrl } from "@/lib/bridgeRelayUrl";

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

const BLOCKED_RESPONSE_HEADERS = new Set<string>([
  "connection",
  "content-length",
  "content-encoding",
  "keep-alive",
  "transfer-encoding",
]);

type BridgeRelayProxyOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
};

type RelayProxyOptions = {
  headers?: HeadersInit;
};

export function hasBridgeRelay(): boolean {
  return resolveBridgeRelayUrl() !== null;
}

async function buildBridgeRelayHeaders(request: Request): Promise<Headers> {
  const access = await getDashboardAccess(request);
  const headers = await buildForwardedAccessHeaders(request);

  if (!access.email && access.provider === "local") {
    headers.set("x-bridge-user-id", "local-admin");
  }

  return headers;
}

export async function proxyToBridgeRelay(
  request: Request,
  pathname: string,
  options: RelayProxyOptions = {},
): Promise<Response> {
  const relayUrl = requireBridgeRelayUrl();
  const incomingUrl = new URL(request.url);
  const target = new URL(pathname, relayUrl);
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

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function guardAndProxyToBridgeRelay(
  request: Request,
  pathname: string,
  options: BridgeRelayProxyOptions = {},
): Promise<Response> {
  const denied = await guardApiAccess(request, options.role ?? "viewer");
  if (denied) {
    return denied;
  }

  if (options.requireActionGuard) {
    const deniedAction = guardApiActionAccess(request as NextRequest);
    if (deniedAction) {
      return deniedAction;
    }
  }

  if (!hasBridgeRelay()) {
    return NextResponse.json(
      { error: "Bridge relay URL is not configured" },
      { status: 503 },
    );
  }

  try {
    return await proxyToBridgeRelay(request, pathname, {
      headers: await buildBridgeRelayHeaders(request),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reach bridge relay" },
      { status: 502 },
    );
  }
}
