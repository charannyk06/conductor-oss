import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

// Not bridge-aware on purpose: saved passwords stay on the machine running the
// backend and are never sent through the relay.
export const GET = guardedProxyRoute("/api/vault/credentials", { role: "admin" });
export const DELETE = guardedProxyRoute("/api/vault/credentials", { role: "admin", requireActionGuard: true });
