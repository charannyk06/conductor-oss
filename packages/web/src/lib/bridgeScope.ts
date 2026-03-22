import { normalizeBridgeId } from "@/lib/bridgeSessionIds";

export type BridgeInventoryStatus = "loading" | "ready" | "error";

type ResolveSelectedBridgeIdInput = {
  requiresPairedDeviceScope: boolean;
  requestedBridgeId?: string | null;
  selectedBridgeId?: string | null;
  connectedBridgeIds: Array<string | null | undefined>;
};

type BridgeScopeStateInput = {
  requiresPairedDeviceScope: boolean;
  effectiveBridgeId?: string | null;
  connectedBridgeIds: Array<string | null | undefined>;
  bridgeInventoryStatus: BridgeInventoryStatus;
};

function normalizeConnectedBridgeIds(connectedBridgeIds: Array<string | null | undefined>): string[] {
  return connectedBridgeIds
    .map((bridgeId) => normalizeBridgeId(bridgeId))
    .filter((bridgeId): bridgeId is string => bridgeId !== null);
}

export function resolveSelectedBridgeId({
  requiresPairedDeviceScope,
  requestedBridgeId,
  selectedBridgeId,
  connectedBridgeIds,
}: ResolveSelectedBridgeIdInput): string {
  const normalizedRequestedBridgeId = normalizeBridgeId(requestedBridgeId);
  const normalizedSelectedBridgeId = normalizeBridgeId(selectedBridgeId);
  const availableBridgeIds = normalizeConnectedBridgeIds(connectedBridgeIds);

  if (requiresPairedDeviceScope) {
    if (normalizedRequestedBridgeId) {
      return normalizedRequestedBridgeId;
    }

    if (availableBridgeIds.length === 0) {
      return "";
    }

    if (normalizedSelectedBridgeId && availableBridgeIds.includes(normalizedSelectedBridgeId)) {
      return normalizedSelectedBridgeId;
    }

    return availableBridgeIds[0] ?? "";
  }

  if (normalizedSelectedBridgeId && availableBridgeIds.includes(normalizedSelectedBridgeId)) {
    return normalizedSelectedBridgeId;
  }

  return "";
}

export function isPairedBridgeScopePending({
  requiresPairedDeviceScope,
  effectiveBridgeId,
  connectedBridgeIds,
  bridgeInventoryStatus,
}: BridgeScopeStateInput): boolean {
  if (!requiresPairedDeviceScope) {
    return false;
  }

  const normalizedEffectiveBridgeId = normalizeBridgeId(effectiveBridgeId);
  if (!normalizedEffectiveBridgeId) {
    return false;
  }

  if (bridgeInventoryStatus === "loading") {
    return true;
  }

  if (bridgeInventoryStatus !== "ready") {
    return false;
  }

  return !normalizeConnectedBridgeIds(connectedBridgeIds).includes(normalizedEffectiveBridgeId);
}

export function isPairedBridgeScopeReady({
  requiresPairedDeviceScope,
  effectiveBridgeId,
  connectedBridgeIds,
  bridgeInventoryStatus,
}: BridgeScopeStateInput): boolean {
  if (!requiresPairedDeviceScope) {
    return true;
  }

  const normalizedEffectiveBridgeId = normalizeBridgeId(effectiveBridgeId);
  if (!normalizedEffectiveBridgeId || bridgeInventoryStatus !== "ready") {
    return false;
  }

  return normalizeConnectedBridgeIds(connectedBridgeIds).includes(normalizedEffectiveBridgeId);
}
