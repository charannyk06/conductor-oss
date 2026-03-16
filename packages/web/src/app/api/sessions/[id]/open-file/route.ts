import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyParamRoute(
  (params) => `/api/sessions/${encodeURIComponent(params.id ?? "")}/open-file`,
  { role: "operator", requireActionGuard: true },
);
