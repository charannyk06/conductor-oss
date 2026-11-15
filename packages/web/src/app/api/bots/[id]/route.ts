import { guardedProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

const pathname = ({ id }: Record<string, string | undefined>) =>
  `/api/bots/${encodeURIComponent(id ?? "")}`;

export const GET = guardedProxyParamRoute(pathname, { role: "viewer" });
export const PATCH = guardedProxyParamRoute(pathname, { role: "operator", requireActionGuard: true });
export const DELETE = guardedProxyParamRoute(pathname, { role: "operator", requireActionGuard: true });
