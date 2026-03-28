import { guardedSessionEventStreamParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedSessionEventStreamParamRoute(
  ({ id }) => `/api/sessions/${encodeURIComponent(id ?? "")}/output/stream`,
  { role: "viewer" },
);
