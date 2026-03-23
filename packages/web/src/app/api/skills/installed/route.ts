import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/skills/installed", {
  role: "viewer",
  bridgeAware: true,
});
