import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/notifications", { role: "viewer" });
export const POST = guardedProxyRoute("/api/notifications", { role: "operator" });
