import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = guardedProxyParamRoute(
  ({ id, task }) =>
    `/api/projects/${encodeURIComponent(id ?? "")}/dispatcher/tasks/${encodeURIComponent(task ?? "")}/handoff`,
  { role: "operator", requireActionGuard: true, bridgeAware: true },
);
