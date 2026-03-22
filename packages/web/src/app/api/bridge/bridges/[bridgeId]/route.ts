import { guardAndProxyToBridgeRelay } from "@/lib/bridgeRelayProxy";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ bridgeId: string }>;
};

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { bridgeId } = await context.params;
  return guardAndProxyToBridgeRelay(
    request,
    `/api/bridges/${encodeURIComponent(bridgeId)}`,
    {
      role: "viewer",
      requireActionGuard: true,
    },
  );
}
