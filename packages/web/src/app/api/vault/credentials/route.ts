import { localOnlyProxy } from "@/lib/localOnlyRoutes";

export const dynamic = "force-dynamic";

// Saved passwords stay on the machine running the backend: these routes are
// never relayed to a paired device and are refused on hosted dashboards.
export function GET(request: Request): Promise<Response> {
  return localOnlyProxy(request, "/api/vault/credentials", { role: "admin" });
}

export function DELETE(request: Request): Promise<Response> {
  return localOnlyProxy(request, "/api/vault/credentials", { role: "admin", requireActionGuard: true });
}
