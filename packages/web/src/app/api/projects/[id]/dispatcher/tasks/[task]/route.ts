import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const PATCH = guardedProxyParamRoute(
  ({ id, task }) =>
    `/api/projects/${encodeURIComponent(id ?? "")}/dispatcher/tasks/${encodeURIComponent(task ?? "")}`,
  { role: "operator", requireActionGuard: true, bridgeAware: true },
);
