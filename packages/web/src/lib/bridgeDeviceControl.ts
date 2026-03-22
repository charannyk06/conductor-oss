type BridgeServiceRestartPayload = {
  ok?: boolean;
  message?: string;
  error?: string;
};

export async function requestBridgeServiceRestart(deviceId: string): Promise<string> {
  const response = await fetch(
    `/api/bridge/devices/${encodeURIComponent(deviceId)}/service-restart`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      cache: "no-store",
    },
  );

  const payload = await response.json().catch(() => null) as BridgeServiceRestartPayload | null;
  if (!response.ok) {
    throw new Error(
      payload?.error
      ?? payload?.message
      ?? `Failed to restart the bridge service (${response.status})`,
    );
  }

  return payload?.message ?? "Bridge service restart requested. This laptop should reconnect shortly.";
}
