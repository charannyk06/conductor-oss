import { localOnlyProxy } from "@/lib/localOnlyRoutes";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return localOnlyProxy(request, `/api/vault/credentials/${encodeURIComponent(id)}`, {
    role: "admin",
    requireActionGuard: true,
  });
}
