import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyParamRoute(
  ({ id }) => `/api/sessions/${encodeURIComponent(id ?? "")}/restore`,
  { role: "operator", requireActionGuard: true },
);
