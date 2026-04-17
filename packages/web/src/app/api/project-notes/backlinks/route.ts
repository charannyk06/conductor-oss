import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/project-notes/backlinks", {
  role: "viewer",
  bridgeAware: true,
});
