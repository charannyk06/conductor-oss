import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/github/projects/sync", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
});
