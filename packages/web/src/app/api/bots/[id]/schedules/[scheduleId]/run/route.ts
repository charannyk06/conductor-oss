import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyParamRoute(
  ({ id, scheduleId }) =>
    `/api/bots/${encodeURIComponent(id ?? "")}/schedules/${encodeURIComponent(scheduleId ?? "")}/run`,
  { role: "operator", requireActionGuard: true },
);
