import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/sessions", { role: "viewer" });
export const POST = guardedProxyRoute("/api/sessions", { role: "operator", requireActionGuard: true });
