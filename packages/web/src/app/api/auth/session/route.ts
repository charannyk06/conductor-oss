import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/auth/session", { requireActionGuard: true });
export const DELETE = guardedProxyRoute("/api/auth/session", { requireActionGuard: true });
