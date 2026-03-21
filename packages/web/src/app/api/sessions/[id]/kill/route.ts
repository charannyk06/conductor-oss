import { guardedSessionProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedSessionProxyParamRoute(
  ({ id }) => `/api/sessions/${encodeURIComponent(id ?? "")}/kill`,
  { role: "operator", requireActionGuard: true },
);
