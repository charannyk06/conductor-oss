import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/push/subscriptions", {
  role: "operator",
  requireActionGuard: true,
});
export const DELETE = guardedProxyRoute("/api/push/subscriptions", {
  role: "operator",
  requireActionGuard: true,
});
