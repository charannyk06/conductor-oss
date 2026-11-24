import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const DELETE = guardedProxyParamRoute(
  (params) => `/api/vault/credentials/${encodeURIComponent(params.id ?? "")}`,
  { role: "admin", requireActionGuard: true },
);
