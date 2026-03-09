import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/app-update", { role: "viewer" });
export const POST = guardedProxyRoute("/api/app-update", { role: "admin", requireActionGuard: true });
