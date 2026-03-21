/**
 * Proxy the ttyd WebSocket through the Next.js dashboard.
 *
 * The ttyd process binds to 127.0.0.1 (unreachable from mobile devices).
 * Routing through this Next.js route makes it accessible via any surface
 * that can reach the dashboard (Tailscale, ngrok, etc.).
 */
import { guardedSessionProxyParamRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guardedSessionProxyParamRoute(
  ({ id }) => `/api/sessions/${encodeURIComponent(id ?? "")}/terminal/ttyd/ws`,
  { role: "viewer" },
);
