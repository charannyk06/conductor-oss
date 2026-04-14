import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/project-notes/file", { role: "viewer", bridgeAware: true });
export const PUT = guardedProxyRoute("/api/project-notes/file", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
});
