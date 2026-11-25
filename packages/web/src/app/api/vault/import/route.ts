import { localOnlyProxy } from "@/lib/localOnlyRoutes";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return localOnlyProxy(request, "/api/vault/import", { role: "admin", requireActionGuard: true });
}
