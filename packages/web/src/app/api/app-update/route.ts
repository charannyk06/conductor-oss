import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/app-update", { role: "viewer", bridgeAware: true });
export const POST = guardedProxyRoute("/api/app-update", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
});
