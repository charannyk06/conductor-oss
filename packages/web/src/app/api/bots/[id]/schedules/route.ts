import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyParamRoute(
  ({ id }) => `/api/bots/${encodeURIComponent(id ?? "")}/schedules`,
  { role: "operator", requireActionGuard: true },
);
