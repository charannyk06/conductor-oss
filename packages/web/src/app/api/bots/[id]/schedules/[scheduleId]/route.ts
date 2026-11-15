import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

const pathname = ({ id, scheduleId }: Record<string, string | undefined>) =>
  `/api/bots/${encodeURIComponent(id ?? "")}/schedules/${encodeURIComponent(scheduleId ?? "")}`;

export const PATCH = guardedProxyParamRoute(pathname, { role: "operator", requireActionGuard: true });
export const DELETE = guardedProxyParamRoute(pathname, { role: "operator", requireActionGuard: true });
