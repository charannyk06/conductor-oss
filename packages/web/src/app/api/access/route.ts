import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/access", { role: "viewer" });
export const PUT = guardedProxyRoute("/api/access", { role: "admin", requireActionGuard: true });
