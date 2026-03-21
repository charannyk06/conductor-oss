import { guardedSessionProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedSessionProxyParamRoute(
  ({ id }) => `/api/sessions/${encodeURIComponent(id ?? "")}/checks`,
  { role: "viewer" },
);
