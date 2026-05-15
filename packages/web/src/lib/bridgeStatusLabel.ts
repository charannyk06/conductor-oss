export type BridgeStatusTone = "online" | "neutral" | "offline";

export type BridgeStatusBadgeLabelInput = {
  relayConfigured: boolean;
  connectedDevices: number;
  totalDevices: number;
  loading: boolean;
};

export function bridgeStatusBadgeLabel(input: BridgeStatusBadgeLabelInput): string {
  if (input.connectedDevices > 0) return "Online";
  if (!input.relayConfigured) return "Local backend";
  if (input.loading) return "Checking";
  if (input.totalDevices === 0) return "No bridge";
  return "Bridge offline";
}

export function bridgeStatusTone(input: BridgeStatusBadgeLabelInput): BridgeStatusTone {
  if (input.connectedDevices > 0) return "online";
  if (!input.relayConfigured || input.totalDevices === 0 || input.loading) return "neutral";
  return "offline";
}
