/**
 * Proxy the ttyd HTTP frontend through the Next.js dashboard.
 *
 * The ttyd process binds to 127.0.0.1 (unreachable from mobile devices).
 * Routing through this Next.js route makes it accessible via any surface
 * that can reach the dashboard (Tailscale, ngrok, etc.).
 */
import { guardAndProxy } from "@/lib/guardedRustProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const incomingUrl = new URL(request.url);
  const search = incomingUrl.search;
  const pathname = `/api/sessions/${encodeURIComponent(id)}/terminal/ttyd${search}`;
  return guardAndProxy(request, pathname, { role: "viewer" });
}
