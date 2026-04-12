import { guardedSessionProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedSessionProxyParamRoute(
  ({ id }) => `/api/sessions/${encodeURIComponent(id ?? "")}/terminal/ttyd/token`,
  { role: "operator" },
);
