import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/skills/session-active", {
  role: "viewer",
  bridgeAware: true,
});
