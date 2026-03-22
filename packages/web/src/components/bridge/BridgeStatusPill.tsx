"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, Download, Laptop, Loader2, RefreshCw } from "lucide-react";
import {
  isBridgeAutoUpdateInFlight,
  readRecentBridgePairing,
  runBridgeAutoUpdate,
  type BridgeAutoUpdateState,
} from "@/lib/bridgeAppUpdate";
import { cn } from "@/lib/cn";
import { requestBridgeServiceRestart } from "@/lib/bridgeDeviceControl";

type BridgeDevice = {
  device_id: string;
  device_name: string;
  hostname: string;
  os: string;
  arch: string;
  connected: boolean;
  last_status: {
    hostname: string;
    os: string;
    connected: boolean;
  } | null;
};

type DevicesResponse = {
  devices?: BridgeDevice[];
  error?: string;
};

type BridgeServiceActionState = {
  deviceId: string | null;
  status: "idle" | "running" | "completed" | "failed";
  message: string | null;
};

type BridgeStatusPillProps = {
  connected?: boolean;
  className?: string;
  title?: string;
};

function StatusBadge({
  connected,
  className,
  title,
  suffix,
}: {
  connected: boolean;
  className?: string;
  title?: string;
  suffix?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[12px] font-medium",
        connected
          ? "border-[rgba(24,197,143,0.35)] bg-[rgba(24,197,143,0.12)] text-[var(--vk-green)]"
          : "border-[rgba(255,143,122,0.24)] bg-[rgba(255,143,122,0.08)] text-[var(--vk-red)]",
        className,
      )}
      title={title}
    >
      <span className={cn(
        "h-2.5 w-2.5 rounded-full",
        connected ? "bg-[var(--vk-green)]" : "bg-[var(--vk-red)]",
      )}
      />
      <span>{connected ? "Online" : "Offline"}</span>
      {suffix}
    </span>
  );
}

function BridgeStatusDropdown({ className }: { className?: string }) {
  const searchParams = useSearchParams();
  const [devices, setDevices] = useState<BridgeDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recentPairingDeviceId, setRecentPairingDeviceId] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState<BridgeAutoUpdateState>({
    deviceId: null,
    phase: "idle",
    message: null,
  });
  const [serviceAction, setServiceAction] = useState<BridgeServiceActionState>({
    deviceId: null,
    status: "idle",
    message: null,
  });
  const autoUpdatedDeviceIdsRef = useRef<Set<string>>(new Set());

  const refreshDevices = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) {
      setLoading(true);
    }
    try {
      const response = await fetch("/api/bridge/devices", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as DevicesResponse | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to load bridge devices (${response.status})`);
      }
      setDevices(payload?.devices ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load bridge devices.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;

    const safeRefresh = async (showSpinner: boolean) => {
      if (cancelled) {
        return;
      }
      await refreshDevices(showSpinner);
    };

    void safeRefresh(true);
    pollTimer = window.setInterval(() => {
      void safeRefresh(false);
    }, 15_000);

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }
    };
  }, [refreshDevices]);

  useEffect(() => {
    const syncRecentPairing = () => {
      setRecentPairingDeviceId(readRecentBridgePairing()?.deviceId ?? null);
    };

    syncRecentPairing();
    window.addEventListener("focus", syncRecentPairing);
    window.addEventListener("storage", syncRecentPairing);

    return () => {
      window.removeEventListener("focus", syncRecentPairing);
      window.removeEventListener("storage", syncRecentPairing);
    };
  }, []);

  const connectedDevices = devices.filter((device) => device.connected);
  const selectedBridgeId = searchParams.get("bridge")?.trim() || null;
  const selectedBridgeDevice = selectedBridgeId
    ? devices.find((device) => device.device_id === selectedBridgeId) ?? null
    : null;
  const recentPairingDevice = recentPairingDeviceId
    ? devices.find((device) => device.device_id === recentPairingDeviceId) ?? null
    : null;
  const connected = connectedDevices.length > 0;
  const title = error
    ?? (connected
      ? `${connectedDevices.length} bridge${connectedDevices.length === 1 ? "" : "s"} online`
      : devices.length > 0
        ? "No paired bridges are online"
        : "No paired bridges yet");

  useEffect(() => {
    const autoUpdateDevice = (recentPairingDevice?.connected ? recentPairingDevice : null)
      ?? (selectedBridgeDevice?.connected ? selectedBridgeDevice : null);

    if (!autoUpdateDevice) {
      return;
    }

    if (autoUpdatedDeviceIdsRef.current.has(autoUpdateDevice.device_id)) {
      return;
    }

    autoUpdatedDeviceIdsRef.current.add(autoUpdateDevice.device_id);
    void runBridgeAutoUpdate(autoUpdateDevice, setAutoUpdate);
  }, [recentPairingDevice, selectedBridgeDevice]);

  useEffect(() => {
    if (!recentPairingDevice || recentPairingDevice.connected || autoUpdate.message) {
      return;
    }

    setAutoUpdate({
      deviceId: recentPairingDevice.device_id,
      phase: "checking",
      message: `Waiting for ${recentPairingDevice.device_name} to reconnect so Conductor can finish its package update.`,
    });
  }, [autoUpdate.message, recentPairingDevice]);

  const handleRestartService = useCallback(async (device: BridgeDevice) => {
    setServiceAction({
      deviceId: device.device_id,
      status: "running",
      message: `Restarting the bridge service on ${device.device_name}.`,
    });

    try {
      const message = await requestBridgeServiceRestart(device.device_id);
      setServiceAction({
        deviceId: device.device_id,
        status: "completed",
        message,
      });
      window.setTimeout(() => {
        void refreshDevices(false);
      }, 2_000);
    } catch (err) {
      setServiceAction({
        deviceId: device.device_id,
        status: "failed",
        message: err instanceof Error ? err.message : `Failed to restart ${device.device_name}.`,
      });
    }
  }, [refreshDevices]);

  const handleUpdateDevice = useCallback(async (device: BridgeDevice) => {
    await runBridgeAutoUpdate(device, setAutoUpdate);
    window.setTimeout(() => {
      void refreshDevices(false);
    }, 2_000);
  }, [refreshDevices]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="outline-none">
          <StatusBadge
            connected={connected}
            className={className}
            title={title}
            suffix={<ChevronDown className="h-3.5 w-3.5 text-current/70" />}
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-[90] w-[320px] rounded-[18px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-2 text-[var(--vk-text-normal)] shadow-[0_22px_48px_rgba(0,0,0,0.34)]"
        >
          <div className="rounded-[14px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
              Conductor Bridge
            </div>
            <div className="mt-2 text-[13px] text-[var(--vk-text-normal)]">
              {connected
                ? `${connectedDevices.length} device${connectedDevices.length === 1 ? "" : "s"} online`
                : loading
                  ? "Loading device status"
                  : "No live bridge connection"}
            </div>
            <div className="mt-2 text-[11px] leading-5 text-[var(--vk-text-faint)]">
              If a laptop is online but misbehaving, use these controls to update Conductor or restart its bridge service.
            </div>
            {error ? (
              <div className="mt-2 text-[12px] leading-5 text-[var(--vk-red)]">{error}</div>
            ) : null}
            {autoUpdate.message ? (
              <div className={cn(
                "mt-2 text-[12px] leading-5",
                autoUpdate.phase === "failed"
                  ? "text-[var(--vk-red)]"
                  : autoUpdate.phase === "skipped"
                    ? "text-[var(--vk-text-muted)]"
                    : "text-[var(--vk-text-faint)]",
              )}
              >
                {autoUpdate.message}
              </div>
            ) : null}
          </div>

          <div className="mt-2 max-h-[280px] overflow-y-auto">
            {devices.length > 0 ? (
              devices.map((device) => {
                const updateInFlight = isBridgeAutoUpdateInFlight(autoUpdate, device.device_id);
                const serviceActionRunning = serviceAction.status === "running"
                  && serviceAction.deviceId === device.device_id;

                return (
                  <div
                    key={device.device_id}
                    className="rounded-[14px] px-3 py-2.5 transition-colors hover:bg-[var(--vk-bg-hover)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-[var(--vk-text-strong)]">
                          {device.device_name}
                        </div>
                        <div className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                          {device.hostname} · {device.os}/{device.arch}
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--vk-text-muted)]">
                          Relay: {device.last_status?.hostname ?? device.hostname}
                        </div>
                        {autoUpdate.message && autoUpdate.deviceId === device.device_id ? (
                          <div className={cn(
                            "mt-1 text-[11px] leading-5",
                            autoUpdate.phase === "failed"
                              ? "text-[var(--vk-red)]"
                              : autoUpdate.phase === "skipped"
                                ? "text-[var(--vk-text-muted)]"
                                : "text-[var(--vk-text-faint)]",
                          )}
                          >
                            {autoUpdate.message}
                          </div>
                        ) : null}
                        {serviceAction.message && serviceAction.deviceId === device.device_id ? (
                          <div className={cn(
                            "mt-1 text-[11px] leading-5",
                            serviceAction.status === "failed"
                              ? "text-[var(--vk-red)]"
                              : serviceAction.status === "completed"
                                ? "text-[var(--vk-green)]"
                                : "text-[var(--vk-text-faint)]",
                          )}
                          >
                            {serviceAction.message}
                          </div>
                        ) : null}
                        {device.connected ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-[10px] border border-[var(--vk-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--vk-text-normal)] transition-colors hover:bg-[var(--vk-bg-hover)]"
                              disabled={updateInFlight || serviceActionRunning}
                              onClick={() => {
                                void handleUpdateDevice(device);
                              }}
                            >
                              {updateInFlight ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Download className="h-3.5 w-3.5" />
                              )}
                              {updateInFlight ? "Updating..." : "Update Conductor"}
                            </button>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-[10px] border border-[var(--vk-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--vk-text-normal)] transition-colors hover:bg-[var(--vk-bg-hover)]"
                              disabled={serviceActionRunning || updateInFlight}
                              onClick={() => {
                                void handleRestartService(device);
                              }}
                            >
                              {serviceActionRunning ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3.5 w-3.5" />
                              )}
                              Restart service
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <BridgeStatusPill connected={device.connected} />
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="rounded-[14px] border border-dashed border-[var(--vk-border)] px-3 py-4 text-[12px] text-[var(--vk-text-muted)]">
                {loading ? "Loading paired devices..." : "Pair a laptop to see bridge status here."}
              </div>
            )}
          </div>

          <DropdownMenu.Separator className="my-2 h-px bg-[var(--vk-border)]" />
          <DropdownMenu.Item asChild>
            <Link
              href="/bridge/connect"
              className="flex items-center justify-between rounded-[12px] px-3 py-2 text-[13px] font-medium text-[var(--vk-text-normal)] outline-none transition-colors hover:bg-[var(--vk-bg-hover)] focus:bg-[var(--vk-bg-hover)]"
            >
              <span>Open bridge connection</span>
              <Laptop className="h-4 w-4 text-[var(--vk-text-muted)]" />
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function BridgeStatusPill({ connected, className, title }: BridgeStatusPillProps = {}) {
  if (typeof connected === "boolean") {
    return <StatusBadge connected={connected} className={className} title={title} />;
  }

  return <BridgeStatusDropdown className={className} />;
}
