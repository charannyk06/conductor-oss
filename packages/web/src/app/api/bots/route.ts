import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/bots", { role: "viewer" });
export const POST = guardedProxyRoute("/api/bots", { role: "operator", requireActionGuard: true });
