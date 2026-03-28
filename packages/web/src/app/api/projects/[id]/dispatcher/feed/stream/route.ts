import { guardedEventStreamParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedEventStreamParamRoute(
  ({ id }) => `/api/projects/${encodeURIComponent(id ?? "")}/dispatcher/feed/stream`,
  { role: "viewer", bridgeAware: true },
);
