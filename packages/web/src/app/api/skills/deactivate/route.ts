import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/skills/deactivate", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
});
