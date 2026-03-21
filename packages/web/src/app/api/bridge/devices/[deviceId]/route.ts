import { guardAndProxyToBridgeRelay } from "@/lib/bridgeRelayProxy";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deviceId: string }>;
};

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { deviceId } = await context.params;
  return guardAndProxyToBridgeRelay(
    request,
    `/api/devices/${encodeURIComponent(deviceId)}`,
    {
      role: "viewer",
      requireActionGuard: true,
    },
  );
}
