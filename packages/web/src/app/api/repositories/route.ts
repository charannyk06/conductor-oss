import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/repositories", { role: "viewer" });
export const DELETE = guardedProxyRoute("/api/repositories", { role: "operator", requireActionGuard: true });
export const PUT = guardedProxyRoute("/api/repositories", { role: "operator", requireActionGuard: true });
