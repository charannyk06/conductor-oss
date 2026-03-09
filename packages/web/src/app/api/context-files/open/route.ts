import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/context-files/open", {
  role: "operator",
  requireActionGuard: true,
});
