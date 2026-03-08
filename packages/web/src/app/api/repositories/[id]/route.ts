import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const DELETE = guardedProxyParamRoute(
  ({ id }) => `/api/repositories/${encodeURIComponent(id ?? "")}`,
  { role: "operator", requireActionGuard: true },
);
