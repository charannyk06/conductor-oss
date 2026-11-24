import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyRoute("/api/vault/import", { role: "admin", requireActionGuard: true });
