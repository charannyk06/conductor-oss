import { guardAndProxyToBridgeDevice } from "@/lib/bridgeApiProxy";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ deviceId: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { deviceId } = await context.params;
  return guardAndProxyToBridgeDevice(
    request,
    deviceId,
    "/_bridge/install",
    {
      role: "admin",
      requireActionGuard: true,
    },
  );
}
