import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/preferences", { role: "viewer" });
export const PUT = guardedProxyRoute("/api/preferences", { role: "operator", requireActionGuard: true });
