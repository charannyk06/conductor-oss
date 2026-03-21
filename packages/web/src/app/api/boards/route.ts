import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/boards", { role: "viewer", bridgeAware: true });
export const POST = guardedProxyRoute("/api/boards", { role: "operator", requireActionGuard: true, bridgeAware: true });
export const PATCH = guardedProxyRoute("/api/boards", { role: "operator", requireActionGuard: true, bridgeAware: true });
