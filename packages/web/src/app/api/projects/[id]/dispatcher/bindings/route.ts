import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyParamRoute(
  ({ id }) => `/api/projects/${encodeURIComponent(id ?? "")}/dispatcher/bindings`,
  { role: "viewer", bridgeAware: true },
);

export const POST = guardedProxyParamRoute(
  ({ id }) => `/api/projects/${encodeURIComponent(id ?? "")}/dispatcher/bindings`,
  { role: "operator", bridgeAware: true },
);
