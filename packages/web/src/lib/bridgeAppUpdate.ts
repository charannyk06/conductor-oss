import { withBridgeQuery } from "@/lib/bridgeQuery";
import { isLegacyBridgeBuildErrorMessage, legacyBridgeBuildActionMessage } from "@/lib/bridgeBuildCompatibility";
import type { AppUpdateStatus } from "@/lib/types";

export const BRIDGE_APP_UPDATE_POLL_INTERVAL_MS = 1_500;
export const BRIDGE_APP_UPDATE_POLL_TIMEOUT_MS = 300_000;

const RECENT_BRIDGE_PAIRING_STORAGE_KEY = "conductor-bridge-recent-pairing";
const RECENT_BRIDGE_PAIRING_TTL_MS = 30 * 60_000;

export type BridgeAutoUpdatePhase =
  | "idle"
  | "checking"
  | "updating"
  | "restarting"
  | "completed"
  | "skipped"
  | "failed";

export type BridgeAutoUpdateState = {
  deviceId: string | null;
  phase: BridgeAutoUpdatePhase;
  message: string | null;
};

export type BridgeAutoUpdateDevice = {
  device_id: string;
  device_name: string;
  connected: boolean;
};

export function isBridgeAutoUpdateInFlight(
  state: BridgeAutoUpdateState,
  deviceId: string,
): boolean {
  return state.deviceId === deviceId
    && (state.phase === "checking" || state.phase === "updating" || state.phase === "restarting");
}

type RecentBridgePairing = {
  deviceId: string;
  deviceName: string | null;
  pairedAt: string;
};

function isRecentBridgePairing(value: unknown): value is RecentBridgePairing {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate["deviceId"] === "string"
    && typeof candidate["pairedAt"] === "string"
    && (candidate["deviceName"] === null || typeof candidate["deviceName"] === "string");
}

function bridgeUpdateMessage(
  device: Pick<BridgeAutoUpdateDevice, "device_name">,
  status: AppUpdateStatus,
): string {
  return status.jobMessage ?? `Installing Conductor ${status.latestVersion ?? "latest"} on ${device.device_name}.`;
}

function normalizeBridgeUpdateError(message: string | null, status: number): string {
  const normalized = message?.trim() ?? "";
  if (isLegacyBridgeBuildErrorMessage(normalized)) {
    return legacyBridgeBuildActionMessage("update");
  }

  return normalized || `Failed to update Conductor on this laptop (${status})`;
}

export function normalizeAppUpdatePayload(payload: unknown): AppUpdateStatus | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return payload as AppUpdateStatus;
}

export function describeAutoUpdateSkip(status: AppUpdateStatus): string {
  if (!status.enabled) {
    switch (status.reason) {
      case "source-checkout":
        return "This laptop is running from a source checkout, so there is no published package to auto-update.";
      case "missing-cli-metadata":
        return "This install could not determine its update metadata, so automatic package updates are unavailable.";
      default:
        return "Automatic package updates are unavailable for this laptop.";
    }
  }

  if (!status.updateAvailable) {
    return "This laptop is already running the latest Conductor release.";
  }

  if (!status.canAutoUpdate) {
    if (status.installMode === "npx") {
      return "This laptop was launched via npx, so the next launch will pick up the latest package automatically.";
    }
    if (status.updateCommand) {
      return `A newer Conductor release is available, but this install still needs a manual update: ${status.updateCommand}`;
    }
    return "A newer Conductor release is available, but this install cannot update itself automatically.";
  }

  return "This laptop is already running the latest Conductor release.";
}

export async function requestBridgeAppUpdate(
  deviceId: string,
  init?: {
    method?: "GET" | "POST";
    force?: boolean;
    body?: { action?: string };
  },
): Promise<AppUpdateStatus> {
  const method = init?.method ?? "GET";
  const pathname = `/api/bridge/devices/${encodeURIComponent(deviceId)}/app-update`;
  const url = new URL(withBridgeQuery(pathname, deviceId), window.location.origin);
  if (init?.force) {
    url.searchParams.set("force", "1");
  }

  const response = await fetch(url.toString(), {
    method,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null) as AppUpdateStatus | { error?: string } | null;
  if (!response.ok) {
    const errorMessage = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : null;
    throw new Error(normalizeBridgeUpdateError(errorMessage, response.status));
  }

  const status = normalizeAppUpdatePayload(payload);
  if (!status) {
    throw new Error("Paired device returned an invalid update payload.");
  }
  return status;
}

export function writeRecentBridgePairing(pairing: {
  deviceId: string;
  deviceName?: string | null;
}): void {
  if (typeof window === "undefined") {
    return;
  }

  const payload: RecentBridgePairing = {
    deviceId: pairing.deviceId,
    deviceName: pairing.deviceName ?? null,
    pairedAt: new Date().toISOString(),
  };

  try {
    window.localStorage.setItem(RECENT_BRIDGE_PAIRING_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage write failures.
  }
}

export function readRecentBridgePairing(): RecentBridgePairing | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(RECENT_BRIDGE_PAIRING_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored) as unknown;
    if (!isRecentBridgePairing(parsed)) {
      window.localStorage.removeItem(RECENT_BRIDGE_PAIRING_STORAGE_KEY);
      return null;
    }

    const pairedAt = Date.parse(parsed.pairedAt);
    if (!Number.isFinite(pairedAt) || Date.now() - pairedAt > RECENT_BRIDGE_PAIRING_TTL_MS) {
      window.localStorage.removeItem(RECENT_BRIDGE_PAIRING_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function runBridgeAutoUpdate(
  device: BridgeAutoUpdateDevice,
  onState: (next: BridgeAutoUpdateState) => void,
): Promise<void> {
  const updateState = (phase: BridgeAutoUpdatePhase, message: string | null) => {
    onState({
      deviceId: device.device_id,
      phase,
      message,
    });
  };

  updateState("checking", `Checking whether ${device.device_name} needs a Conductor package update.`);

  try {
    let status = await requestBridgeAppUpdate(device.device_id, { force: true });

    if (status.restarting) {
      updateState(
        "restarting",
        status.jobMessage ?? `Restart requested on ${device.device_name}. This page will reconnect once the bridge runtime is back online.`,
      );
      return;
    }

    if (status.jobStatus === "running") {
      updateState("updating", bridgeUpdateMessage(device, status));
    } else if (!status.updateAvailable || !status.enabled || !status.canAutoUpdate) {
      updateState(
        !status.enabled || !status.canAutoUpdate ? "skipped" : "completed",
        describeAutoUpdateSkip(status),
      );
      return;
    } else {
      status = await requestBridgeAppUpdate(device.device_id, { method: "POST" });
      updateState("updating", bridgeUpdateMessage(device, status));
    }

    const deadline = Date.now() + BRIDGE_APP_UPDATE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (status.jobStatus !== "running") {
        break;
      }

      await new Promise((resolveDelay) => {
        window.setTimeout(resolveDelay, BRIDGE_APP_UPDATE_POLL_INTERVAL_MS);
      });

      status = await requestBridgeAppUpdate(device.device_id);
      if (status.restarting) {
        updateState(
          "restarting",
          status.jobMessage ?? `Restart requested on ${device.device_name}. This page will reconnect once the bridge runtime is back online.`,
        );
        return;
      }

      updateState("updating", bridgeUpdateMessage(device, status));
    }

    if (status.jobStatus === "running") {
      updateState(
        "updating",
        `The package update is still running on ${device.device_name}. Leave this page open and Conductor will finish applying it in the background.`,
      );
      return;
    }

    if (status.jobStatus === "failed") {
      throw new Error(status.jobMessage ?? status.error ?? `Automatic package update failed on ${device.device_name}.`);
    }

    if (status.restartRequired) {
      if (status.canRestart) {
        status = await requestBridgeAppUpdate(device.device_id, {
          method: "POST",
          body: { action: "restart" },
        });
        updateState(
          "restarting",
          status.jobMessage ?? `Restart requested on ${device.device_name} to finish updating Conductor.`,
        );
        return;
      }

      updateState(
        "completed",
        status.jobMessage ?? `The latest Conductor package is installed on ${device.device_name}. Restart that laptop to finish updating.`,
      );
      return;
    }

    updateState(
      "completed",
      status.jobMessage ?? `${device.device_name} is now updated to Conductor ${status.latestVersion ?? "latest"}.`,
    );
  } catch (error) {
    updateState(
      "failed",
      error instanceof Error ? error.message : `Failed to auto-update ${device.device_name}.`,
    );
  }
}
