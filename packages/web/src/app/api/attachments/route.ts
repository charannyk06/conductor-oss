import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/attachments", {
  role: "operator",
  requireActionGuard: true,
  bridgeAware: true,
});
