import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const PATCH = guardedProxyParamRoute(
  ({ id }) => `/api/projects/${encodeURIComponent(id ?? "")}/dispatcher/integration`,
  { role: "operator", requireActionGuard: true, bridgeAware: true },
);
