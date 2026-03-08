import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyParamRoute(
  ({ id }) => `/api/sessions/${encodeURIComponent(id ?? "")}/diff`,
  { role: "viewer" },
);
