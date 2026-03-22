import type { DashboardRole } from "@conductor-oss/core/types";
import { guardAndProxyToBridgeDevice } from "@/lib/bridgeApiProxy";
import { decodeBridgeSessionId } from "@/lib/bridgeSessionIds";

type BridgeSessionProxyOptions = {
  role?: DashboardRole;
  requireActionGuard?: boolean;
};

export async function maybeProxyBridgeSessionRequest(
  request: Request,
  sessionId: string,
  buildPathname: (sessionId: string) => string,
  options: BridgeSessionProxyOptions = {},
): Promise<Response | null> {
  const bridgeSession = decodeBridgeSessionId(sessionId);
  if (bridgeSession) {
    return guardAndProxyToBridgeDevice(
      request,
      bridgeSession.bridgeId,
      buildPathname(bridgeSession.sessionId),
      options,
    );
  }

  return null;
}
