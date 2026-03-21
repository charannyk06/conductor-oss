import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/workspaces/branches", { role: "viewer", bridgeAware: true });
