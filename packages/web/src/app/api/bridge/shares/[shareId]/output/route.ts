import { NextResponse } from "next/server";
import { hasBridgeRelay, proxyToBridgeRelay } from "@/lib/bridgeRelayProxy";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ shareId: string }>;
};

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { shareId } = await context.params;
  if (!hasBridgeRelay()) {
    return NextResponse.json(
      { error: "Bridge relay URL is not configured" },
      { status: 503 },
    );
  }

  try {
    return await proxyToBridgeRelay(
      request,
      `/api/shares/${encodeURIComponent(shareId)}/output`,
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reach bridge relay" },
      { status: 502 },
    );
  }
}
