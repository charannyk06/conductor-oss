import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/notifications", { role: "viewer", bridgeAware: true });
export const POST = guardedProxyRoute("/api/notifications", { role: "operator", bridgeAware: true });
