import { NextRequest, NextResponse } from "next/server";
import { getDashboardAccess, guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import {
  buildBridgeRelayAuthHeaders,
  buildBridgeRelayWebSocketUrl,
  resolveBridgeRelayUserId,
  signBridgeRelayJwt,
} from "@/lib/bridgeRelayAuth";
import { getBridgeIdFromRequest } from "@/lib/bridgeApiProxy";
import { requireBridgeRelayUrl } from "@/lib/bridgeRelayUrl";
import { decodeBridgeSessionId } from "@/lib/bridgeSessionIds";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) {
    return denied;
  }

  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) {
    return deniedAction;
  }

  const { id } = await context.params;
  const bridgeSession = decodeBridgeSessionId(id);
  const bridgeId = bridgeSession?.bridgeId ?? getBridgeIdFromRequest(request);
  const sessionId = bridgeSession?.sessionId ?? id.trim();
  if (!bridgeId || !sessionId) {
    return NextResponse.json(
      { error: "Relay terminals are only available for paired-device sessions." },
      { status: 400 },
    );
  }

  const access = await getDashboardAccess(request);
  const userId = resolveBridgeRelayUserId(access);
  if (!userId) {
    return NextResponse.json(
      { error: "Unable to resolve the dashboard user for the bridge relay." },
      { status: 403 },
    );
  }

  try {
    const relayTarget = new URL(
      `/api/devices/${encodeURIComponent(bridgeId)}/terminals`,
      requireBridgeRelayUrl(),
    );
    const relayResponse = await fetch(relayTarget, {
      method: "POST",
      headers: new Headers({
        ...(Object.fromEntries((await buildBridgeRelayAuthHeaders(request)).entries())),
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ session_id: sessionId }),
      cache: "no-store",
      redirect: "manual",
    });

    const payload = (await relayResponse.json().catch(() => null)) as
      | { terminal_id?: string; error?: string }
      | null;
    if (!relayResponse.ok || !payload?.terminal_id) {
      return NextResponse.json(
        {
          error: payload?.error ?? `Failed to create relay terminal session (${relayResponse.status})`,
        },
        { status: relayResponse.status || 502 },
      );
    }

    const jwt = await signBridgeRelayJwt(userId, "terminal-browser");
    return NextResponse.json({
      wsUrl: buildBridgeRelayWebSocketUrl(
        `/terminal/${encodeURIComponent(payload.terminal_id)}/browser`,
      ),
      wsProtocol: jwt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect relay terminal" },
      { status: 502 },
    );
  }
}
