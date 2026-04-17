import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/project-notes/daily", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
});
