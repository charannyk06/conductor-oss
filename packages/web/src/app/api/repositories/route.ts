import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/repositories", { role: "viewer", bridgeAware: true });
export const DELETE = guardedProxyRoute("/api/repositories", { role: "operator", requireActionGuard: true, bridgeAware: true });
export const PUT = guardedProxyRoute("/api/repositories", { role: "operator", requireActionGuard: true, bridgeAware: true });
