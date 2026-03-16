import { guardAndProxy } from "@/lib/guardedRustProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return guardAndProxy(
    request,
    `/api/sessions/${encodeURIComponent(id)}/terminal/connection`,
    { role: "viewer" },
  );
}
