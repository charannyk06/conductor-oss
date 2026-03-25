import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/skills/catalog", {
  role: "viewer",
  bridgeAware: true,
});
