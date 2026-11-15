import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyParamRoute(
  ({ id }) => `/api/bots/${encodeURIComponent(id ?? "")}/thread`,
  { role: "operator", requireActionGuard: true },
);
