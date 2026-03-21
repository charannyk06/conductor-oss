import type { DashboardRole } from "@conductor-oss/core/types";
import { NextRequest, NextResponse } from "next/server";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { requireBridgeRelayUrl, resolveBridgeRelayUrl } from "@/lib/bridgeRelayUrl";
import { normalizeBridgeId } from "@/lib/bridgeSessionIds";
import { buildForwardedAccessHeaders } from "@/lib/guardedRustProxy";

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "keep-alive",
  "transfer-encoding",
]);

const BRIDGE_PROXY_REQUEST_META_KEY = "$bridgeRequest";

type GuardOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
};

type DeviceProxyOptions = {
  responseMapper?: (payload: unknown, bridgeId: string) => unknown;
  pathOverride?: string;
  bodyOverride?: unknown;
};

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json");
}

function copyResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

async function readProxyBody(request: Request, bodyOverride?: unknown): Promise<unknown> {
  if (bodyOverride !== undefined) {
    return bodyOverride;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    const text = await request.text();
    if (text.trim().length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) {
    return undefined;
  }

  return {
    [BRIDGE_PROXY_REQUEST_META_KEY]: {
      kind: "bytes",
      base64: Buffer.from(body).toString("base64"),
      contentType,
    },
  };
}

export function hasBridgeRelay(): boolean {
  return resolveBridgeRelayUrl() !== null;
}

export function getBridgeIdFromRequest(request: Request): string | null {
  return normalizeBridgeId(new URL(request.url).searchParams.get("bridgeId"));
}

export async function proxyToBridgeDevice(
  request: Request,
  bridgeId: string,
  pathname: string,
  options: DeviceProxyOptions = {},
): Promise<Response> {
  const relayUrl = requireBridgeRelayUrl();
  const incomingUrl = new URL(request.url);
  const target = new URL(`/api/devices/${encodeURIComponent(bridgeId)}/proxy`, relayUrl);
  const headers = await buildForwardedAccessHeaders(request);
  headers.set("Content-Type", "application/json");
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
  headers.set("x-forwarded-host", incomingUrl.host);

  const path = options.pathOverride ?? `${pathname}${incomingUrl.search}`;
  const body = {
    method: request.method,
    path,
    body: await readProxyBody(request, options.bodyOverride),
  };

  const response = await fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "manual",
  });

  if (!options.responseMapper || !isJsonResponse(response)) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: copyResponseHeaders(response),
    });
  }

  const payload = await response.json().catch(() => null);
  const mappedPayload = options.responseMapper(payload, bridgeId);
  const headersWithJson = copyResponseHeaders(response);
  headersWithJson.set("Content-Type", "application/json");
  return new Response(JSON.stringify(mappedPayload), {
    status: response.status,
    statusText: response.statusText,
    headers: headersWithJson,
  });
}

export async function guardAndProxyToBridgeDevice(
  request: Request,
  bridgeId: string,
  pathname: string,
  options: GuardOptions & DeviceProxyOptions = {},
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
    return await proxyToBridgeDevice(request, bridgeId, pathname, options);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reach paired device" },
      { status: 502 },
    );
  }
}
