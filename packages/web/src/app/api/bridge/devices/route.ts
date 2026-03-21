import { guardAndProxyToBridgeRelay } from "@/lib/bridgeRelayProxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return guardAndProxyToBridgeRelay(request, "/api/devices/list", { role: "viewer" });
}
