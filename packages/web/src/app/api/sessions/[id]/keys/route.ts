import { guardedSessionProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedSessionProxyParamRoute(
  ({ id }) => `/api/sessions/${encodeURIComponent(id ?? "")}/keys`,
  { role: "operator", requireActionGuard: true },
);
