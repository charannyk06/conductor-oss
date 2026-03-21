import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/preferences", { role: "viewer", bridgeAware: true });
export const PUT = guardedProxyRoute("/api/preferences", { role: "operator", requireActionGuard: true, bridgeAware: true });
