import { guardAndProxyToBridgeRelay } from "@/lib/bridgeRelayProxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return guardAndProxyToBridgeRelay(request, "/api/shares", { role: "viewer" });
}

export async function POST(request: Request): Promise<Response> {
  return guardAndProxyToBridgeRelay(request, "/api/shares", {
    role: "viewer",
    requireActionGuard: true,
  });
}
