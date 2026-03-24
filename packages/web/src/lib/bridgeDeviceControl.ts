import {
  isLegacyBridgeBuildErrorMessage,
  legacyBridgeBuildActionMessage,
} from "@/lib/bridgeBuildCompatibility";

type BridgeDeviceControlPayload = {
  ok?: boolean;
  message?: string;
  error?: string;
};

function normalizeBridgeControlError(
  action: "repair" | "service-restart",
  message: string | null,
  status: number
): string {
  const normalized = message?.trim() ?? "";
  if (isLegacyBridgeBuildErrorMessage(normalized)) {
    return legacyBridgeBuildActionMessage(
      action === "repair" ? "repair" : "restart"
    );
  }

  return (
    normalized || `Failed to run ${action} on the bridge service (${status})`
  );
}

export async function requestBridgeServiceRestart(
  deviceId: string
): Promise<string> {
  const payload = await requestBridgeDeviceControl(
    deviceId,
    "service-restart",
    {}
  );
  return (
    payload?.message ??
    "Bridge service restart scheduled. This laptop should reconnect once the bridge is back online."
  );
}

export async function requestBridgeRepair(
  deviceId: string,
  installScriptUrl: string
): Promise<string> {
  const payload = await requestBridgeDeviceControl(deviceId, "repair", {
    installScriptUrl,
  });
  return (
    payload?.message ??
    "Bridge reinstall requested. This laptop should reconnect shortly."
  );
}

async function requestBridgeDeviceControl(
  deviceId: string,
  action: "repair" | "service-restart",
  body: Record<string, unknown>
): Promise<BridgeDeviceControlPayload | null> {
  const response = await fetch(
    `/api/bridge/devices/${encodeURIComponent(deviceId)}/${action}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    }
  );

  const payload = (await response
    .json()
    .catch(() => null)) as BridgeDeviceControlPayload | null;
  if (!response.ok) {
    throw new Error(
      normalizeBridgeControlError(
        action,
        payload?.error ?? payload?.message ?? null,
        response.status
      )
    );
  }

  return payload;
}
