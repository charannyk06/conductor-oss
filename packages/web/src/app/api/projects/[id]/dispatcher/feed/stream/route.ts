import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyParamRoute(
  ({ id }) => `/api/projects/${encodeURIComponent(id ?? "")}/dispatcher/feed/stream`,
  { role: "viewer", bridgeAware: true },
);
