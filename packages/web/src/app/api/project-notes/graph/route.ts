import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/project-notes/graph", {
  role: "viewer",
  bridgeAware: true,
});
