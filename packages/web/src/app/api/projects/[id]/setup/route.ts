import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyParamRoute(
  ({ id }) => `/api/projects/${encodeURIComponent(id ?? "")}/setup`,
  { role: "operator", requireActionGuard: true, bridgeAware: true },
);
