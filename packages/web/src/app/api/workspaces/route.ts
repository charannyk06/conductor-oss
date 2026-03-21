import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/workspaces", { role: "viewer", bridgeAware: true });
export const POST = guardedProxyRoute("/api/workspaces", { role: "operator", requireActionGuard: true, bridgeAware: true });
