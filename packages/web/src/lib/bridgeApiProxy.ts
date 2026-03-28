import type { DashboardRole } from "@conductor-oss/core/types";
import { NextRequest, NextResponse } from "next/server";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { buildBridgeRelayAuthHeaders } from "@/lib/bridgeRelayAuth";
import { requireBridgeRelayUrl, resolveBridgeRelayUrl } from "@/lib/bridgeRelayUrl";
import { normalizeBridgeId } from "@/lib/bridgeSessionIds";

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

export type BridgePreviewRequest = {
  sessionId: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  bodyBase64?: string | null;
};

export type BridgePreviewResponse = {
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string | null;
};

type BridgePreviewResponsePayload = {
  status?: unknown;
  headers?: unknown;
  body_base64?: unknown;
};

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("application/json");
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
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

function buildEventStreamHeaders(response: Response): Headers {
  const headers = copyResponseHeaders(response);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");
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
  const searchParams = new URL(request.url).searchParams;
  return normalizeBridgeId(searchParams.get("bridgeId") ?? searchParams.get("bridge"));
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
  const headers = await buildBridgeRelayAuthHeaders(request);
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

export async function proxyEventStreamToBridgeDevice(
  request: Request,
  bridgeId: string,
  pathname: string,
): Promise<Response> {
  const response = await proxyToBridgeDevice(request, bridgeId, pathname);

  if (!response.ok || !response.body || !isEventStreamResponse(response)) {
    return response;
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: buildEventStreamHeaders(response),
  });
}

export async function requestBridgePreview(
  bridgeId: string,
  forwardedHeaders: HeadersInit,
  payload: BridgePreviewRequest,
): Promise<BridgePreviewResponse> {
  const relayUrl = requireBridgeRelayUrl();
  const target = new URL(`/api/devices/${encodeURIComponent(bridgeId)}/preview`, relayUrl);
  const headers = new Headers(forwardedHeaders);
  headers.set("Content-Type", "application/json");

  const response = await fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify({
      session_id: payload.sessionId,
      method: payload.method,
      url: payload.url,
      headers: payload.headers ?? {},
      body_base64: payload.bodyBase64 ?? null,
    }),
    cache: "no-store",
    redirect: "manual",
  });

  const body = await response.json().catch(() => null) as
    | BridgePreviewResponse
    | { error?: string }
    | null;

  if (!response.ok) {
    throw new Error(
      body && typeof body === "object" && "error" in body && body.error
        ? body.error
        : "Failed to reach paired device preview",
    );
  }

  const previewBody = body && typeof body === "object"
    ? body as BridgePreviewResponsePayload
    : null;

  return {
    status: typeof previewBody?.status === "number" ? previewBody.status : 502,
    headers: previewBody?.headers && typeof previewBody.headers === "object"
      ? previewBody.headers as Record<string, string>
      : {},
    bodyBase64: typeof previewBody?.body_base64 === "string" || previewBody?.body_base64 === null
      ? previewBody.body_base64 as string | null
      : undefined,
  };
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

export async function guardAndProxyEventStreamToBridgeDevice(
  request: Request,
  bridgeId: string,
  pathname: string,
  options: GuardOptions = {},
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
    return await proxyEventStreamToBridgeDevice(request, bridgeId, pathname);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reach paired device" },
      { status: 502 },
    );
  }
}
