import { guardAndProxyToBridgeRelay } from "@/lib/bridgeRelayProxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return guardAndProxyToBridgeRelay(request, "/api/devices/claims/complete", {
    role: "viewer",
    requireActionGuard: true,
  });
}
