import { NextResponse } from "next/server";
import { guardAndProxy } from "@/lib/guardedRustProxy";
import {
  buildStableBridgeTtydProxyUrl,
  ensureBridgeTtydSession,
  resolveBridgeSessionTarget,
} from "@/lib/bridgeTtyd";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;

  if (!resolveBridgeSessionTarget(id, request)) {
    return guardAndProxy(
      request,
      `/api/sessions/${encodeURIComponent(id ?? "")}/terminal/token`,
      { role: "operator" },
    );
  }

  const ensured = await ensureBridgeTtydSession(request, id, "operator");
  if (!ensured.ok) {
    return ensured.response;
  }

  const tunnelUrl = typeof ensured.upstreamPayload?.tunnelUrl === "string"
    ? ensured.upstreamPayload.tunnelUrl
    : null;
  const hasFrontendHtml = typeof ensured.upstreamPayload?.ttydHttpUrl === "string"
    && ensured.upstreamPayload.ttydHttpUrl.trim().length > 0;

  return NextResponse.json({
    required: false,
    expiresInSeconds: null,
    ttydHttpUrl: hasFrontendHtml
      ? buildStableBridgeTtydProxyUrl(
        ensured.routeSessionId,
        ensured.bridgeId,
      )
      : null,
    ttydWsUrl: ensured.relayTtydWsUrl,
    relayTtydWsUrl: ensured.relayTtydWsUrl,
    tunnelUrl,
  });
}
