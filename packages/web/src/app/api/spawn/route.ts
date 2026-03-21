import { mapBridgeSessionPayload } from "@/lib/bridgeSessionIds";
import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/spawn", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
  responseMapper: mapBridgeSessionPayload,
});
