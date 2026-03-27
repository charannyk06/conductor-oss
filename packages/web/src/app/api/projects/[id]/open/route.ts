import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyParamRoute(
  (params) => `/api/projects/${encodeURIComponent(params.id ?? "")}/open`,
  { role: "operator", requireActionGuard: true, bridgeAware: true },
);
