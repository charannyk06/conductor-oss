import { guardAndProxy } from "@/lib/guardedRustProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const response = await guardAndProxy(
    request,
    `/api/sessions/${encodeURIComponent(id)}/terminal/stream`,
    { role: "viewer" },
  );

  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.includes("text/event-stream")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
