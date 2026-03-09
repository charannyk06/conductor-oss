import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/boards/comments", {
  role: "operator",
  requireActionGuard: true,
});
