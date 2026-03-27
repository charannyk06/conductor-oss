import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyParamRoute(
  ({ id }) => `/api/projects/${encodeURIComponent(id ?? "")}/dispatcher/feed`,
  { role: "viewer", bridgeAware: true },
);
