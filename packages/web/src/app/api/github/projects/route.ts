import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/github/projects", { role: "operator", bridgeAware: true });
export const PUT = guardedProxyRoute("/api/github/projects", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
});
