import { mapBridgeSessionPayload } from "@/lib/bridgeSessionIds";
import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/sessions", {
  role: "viewer",
  bridgeAware: true,
  responseMapper: mapBridgeSessionPayload,
});
export const POST = guardedProxyRoute("/api/sessions", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
  responseMapper: mapBridgeSessionPayload,
});
