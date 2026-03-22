"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Laptop,
  Loader2,
  RefreshCw,
  TerminalSquare,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { BridgeLocalRepairNotice } from "@/components/bridge/BridgeLocalRepairNotice";
import { BridgeStatusPill } from "@/components/bridge/BridgeStatusPill";
import { PublicPageShell } from "@/components/public/PublicPageShell";
import { SessionTerminal } from "@/components/sessions/SessionTerminal";
import { Button } from "@/components/ui/Button";
import {
  isBridgeAutoUpdateInFlight,
  readRecentBridgePairing,
  runBridgeAutoUpdate,
  type BridgeAutoUpdateState,
  writeRecentBridgePairing,
} from "@/lib/bridgeAppUpdate";
import { isLegacyBridgeBuildErrorMessage } from "@/lib/bridgeBuildCompatibility";
import { cn } from "@/lib/cn";
import {
  requestBridgeRepair,
  requestBridgeServiceRestart,
} from "@/lib/bridgeDeviceControl";
import {
  buildBridgeBootstrapConnectCommand,
  buildBridgeConnectCommand,
  buildBridgeInstallCommand,
  buildBridgeManualPairCommand,
} from "@/lib/bridgeOnboarding";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import type { DashboardSession } from "@/lib/types";
import { TERMINAL_STATUSES } from "@/lib/types";

type Device = {
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
  devices?: Device[];
  error?: string;
};

type PairingCodeResponse = {
  code?: string;
  expires_in?: number;
  error?: string;
};

type ClaimCompletionResponse = {
  paired?: boolean;
  already_paired?: boolean;
  device_id?: string;
  device_name?: string;
  error?: string;
};

type SessionsResponse = DashboardSession[] | {
  sessions?: DashboardSession[];
  error?: string;
};

type BridgeServiceActionState = {
  deviceId: string | null;
  kind: "repair" | "restart" | null;
  status: "idle" | "running" | "completed" | "failed";
  message: string | null;
};

function normalizeSessionsPayload(payload: SessionsResponse | null): DashboardSession[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.sessions ?? [];
}

function pickBridgeTestSession(sessions: DashboardSession[]): DashboardSession | null {
  return sessions.find((session) => !TERMINAL_STATUSES.has(session.status))
    ?? sessions[0]
    ?? null;
}

function formatDeviceDescriptor(device: Device): string {
  return `${device.hostname} · ${device.os}/${device.arch}`;
}

function Panel({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        "rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6",
        "shadow-[0_18px_36px_rgba(0,0,0,0.2)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--vk-text-muted)]">
      {children}
    </p>
  );
}

function StatPill({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-1.5 text-xs text-[var(--vk-text-muted)]">
      {children}
    </div>
  );
}

function CommandBlock({
  title,
  description,
  command,
  children,
  footer,
}: {
  title: string;
  description: string;
  command: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-5">
      <h3 className="text-base font-semibold text-[var(--vk-text-strong)]">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">{description}</p>
      {children}
      <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3 font-mono text-sm leading-6 text-[var(--vk-text-normal)]">
        {command}
      </pre>
      {footer ? <div className="mt-4 flex flex-wrap gap-2">{footer}</div> : null}
    </div>
  );
}

export default function BridgeConnectClient({
  initialClaimToken = null,
  initialSelectedDeviceId = null,
  dashboardUrl,
  relayUrl,
  installScriptUrl,
}: {
  initialClaimToken?: string | null;
  initialSelectedDeviceId?: string | null;
  dashboardUrl: string;
  relayUrl: string | null;
  installScriptUrl: string;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingCode, setCreatingCode] = useState(false);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<"setup" | "install" | "connect" | "manual" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testConnectionOpen, setTestConnectionOpen] = useState(false);
  const [testConnectionLoading, setTestConnectionLoading] = useState(false);
  const [testConnectionError, setTestConnectionError] = useState<string | null>(null);
  const [testSession, setTestSession] = useState<DashboardSession | null>(null);
  const [claimStatus, setClaimStatus] = useState<"idle" | "pending" | "paired">(
    initialClaimToken ? "pending" : "idle",
  );
  const [showAdvancedSetup, setShowAdvancedSetup] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimedDevice, setClaimedDevice] = useState<{ deviceId: string; deviceName: string } | null>(null);
  const [recentPairingDeviceId, setRecentPairingDeviceId] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(initialSelectedDeviceId);
  const [pairingAutoUpdate, setPairingAutoUpdate] = useState<BridgeAutoUpdateState>({
    deviceId: null,
    phase: "idle",
    message: null,
  });
  const [serviceAction, setServiceAction] = useState<BridgeServiceActionState>({
    deviceId: null,
    kind: null,
    status: "idle",
    message: null,
  });
  const autoUpdatedDeviceIdsRef = useRef<Set<string>>(new Set());

  const bootstrapConnectCommand = useMemo(
    () => buildBridgeBootstrapConnectCommand(installScriptUrl, dashboardUrl, relayUrl),
    [dashboardUrl, installScriptUrl, relayUrl],
  );
  const installCommand = useMemo(
    () => buildBridgeInstallCommand(installScriptUrl),
    [installScriptUrl],
  );
  const connectCommand = useMemo(
    () => buildBridgeConnectCommand(dashboardUrl, relayUrl),
    [dashboardUrl, relayUrl],
  );
  const manualCommand = useMemo(
    () => buildBridgeManualPairCommand(pairingCode, relayUrl),
    [pairingCode, relayUrl],
  );
  const connectedDevices = devices.filter((device) => device.connected);
  const claimedDeviceRecord = useMemo(
    () => claimedDevice
      ? devices.find((device) => device.device_id === claimedDevice.deviceId) ?? null
      : null,
    [claimedDevice, devices],
  );
  const recentPairingDeviceRecord = useMemo(
    () => recentPairingDeviceId
      ? devices.find((device) => device.device_id === recentPairingDeviceId) ?? null
      : null,
    [devices, recentPairingDeviceId],
  );
  const selectedDevice = useMemo(
    () => devices.find((device) => device.device_id === selectedDeviceId)
      ?? claimedDeviceRecord
      ?? recentPairingDeviceRecord
      ?? connectedDevices[0]
      ?? devices[0]
      ?? null,
    [claimedDeviceRecord, connectedDevices, devices, recentPairingDeviceRecord, selectedDeviceId],
  );
  const readyDevice = useMemo(
    () => (claimedDeviceRecord?.connected ? claimedDeviceRecord : null)
      ?? (recentPairingDeviceRecord?.connected ? recentPairingDeviceRecord : null)
      ?? (selectedDevice?.connected ? selectedDevice : null)
      ?? connectedDevices[0]
      ?? null,
    [claimedDeviceRecord, connectedDevices, recentPairingDeviceRecord, selectedDevice],
  );
  const readyDashboardHref = readyDevice
    ? `/?bridge=${encodeURIComponent(readyDevice.device_id)}`
    : null;
  const selectedDeviceActionRunning = Boolean(selectedDevice)
    && serviceAction.status === "running"
    && serviceAction.deviceId === selectedDevice?.device_id;
  const selectedDeviceRepairRunning = selectedDeviceActionRunning && serviceAction.kind === "repair";
  const selectedDeviceRestartRunning = selectedDeviceActionRunning && serviceAction.kind === "restart";
  const selectedDeviceNeedsLocalRepair = Boolean(selectedDevice) && (
    (serviceAction.deviceId === selectedDevice?.device_id && isLegacyBridgeBuildErrorMessage(serviceAction.message))
    || (pairingAutoUpdate.deviceId === selectedDevice?.device_id && isLegacyBridgeBuildErrorMessage(pairingAutoUpdate.message))
  );

  useEffect(() => {
    setSelectedDeviceId((current) => {
      if (current && (devices.length === 0 || devices.some((device) => device.device_id === current))) {
        return current;
      }
      if (
        initialSelectedDeviceId
        && (devices.length === 0 || devices.some((device) => device.device_id === initialSelectedDeviceId))
      ) {
        return initialSelectedDeviceId;
      }
      return claimedDeviceRecord?.device_id
        ?? recentPairingDeviceRecord?.device_id
        ?? connectedDevices[0]?.device_id
        ?? devices[0]?.device_id
        ?? null;
    });
  }, [claimedDeviceRecord, connectedDevices, devices, initialSelectedDeviceId, recentPairingDeviceRecord]);

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

  const refreshDevices = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch("/api/bridge/devices", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as DevicesResponse | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to load devices (${response.status})`);
      }
      setDevices(payload?.devices ?? []);
      setError(null);
    } catch (err) {
      setDevices([]);
      setError(err instanceof Error ? err.message : "Failed to load paired devices.");
    } finally {
      setLoading(false);
    }
  }, []);

  const completeClaim = useCallback(async (): Promise<void> => {
    if (!initialClaimToken) {
      return;
    }

    setClaimStatus("pending");
    setClaimError(null);
    try {
      const response = await fetch("/api/bridge/devices/claims/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_token: initialClaimToken }),
      });
      const payload = await response.json().catch(() => null) as ClaimCompletionResponse | null;
      if (!response.ok || !payload?.paired || !payload.device_id || !payload.device_name) {
        throw new Error(payload?.error ?? `Failed to pair this laptop (${response.status})`);
      }

      setClaimedDevice({
        deviceId: payload.device_id,
        deviceName: payload.device_name,
      });
      writeRecentBridgePairing({
        deviceId: payload.device_id,
        deviceName: payload.device_name,
      });
      setRecentPairingDeviceId(payload.device_id);
      setClaimStatus("paired");
      await refreshDevices();
    } catch (err) {
      setClaimStatus("idle");
      setClaimError(err instanceof Error ? err.message : "Failed to complete the laptop claim.");
    }
  }, [initialClaimToken, refreshDevices]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    if (!initialClaimToken) {
      return;
    }
    void completeClaim();
  }, [completeClaim, initialClaimToken]);

  useEffect(() => {
    const autoUpdateDevice = (claimedDeviceRecord?.connected ? claimedDeviceRecord : null)
      ?? (recentPairingDeviceRecord?.connected ? recentPairingDeviceRecord : null)
      ?? (selectedDevice?.connected ? selectedDevice : null);

    if (!autoUpdateDevice) {
      return;
    }

    if (autoUpdatedDeviceIdsRef.current.has(autoUpdateDevice.device_id)) {
      return;
    }

    autoUpdatedDeviceIdsRef.current.add(autoUpdateDevice.device_id);
    void runBridgeAutoUpdate(autoUpdateDevice, setPairingAutoUpdate);
  }, [claimStatus, claimedDeviceRecord, recentPairingDeviceRecord, selectedDevice]);

  useEffect(() => {
    if (!recentPairingDeviceRecord || recentPairingDeviceRecord.connected || pairingAutoUpdate.message) {
      return;
    }

    setPairingAutoUpdate({
      deviceId: recentPairingDeviceRecord.device_id,
      phase: "checking",
      message: `Waiting for ${recentPairingDeviceRecord.device_name} to come online so Conductor can finish checking its package version.`,
    });
  }, [pairingAutoUpdate.message, recentPairingDeviceRecord]);

  useEffect(() => {
    const waitingForRecentPairing = Boolean(recentPairingDeviceId)
      && !recentPairingDeviceRecord?.connected;
    const waitingForSelectedDevice = Boolean(selectedDeviceId)
      && !selectedDevice?.connected;

    if (
      !initialClaimToken
      && !(claimStatus === "paired" && connectedDevices.length === 0)
      && !waitingForRecentPairing
      && !waitingForSelectedDevice
    ) {
      return;
    }

    const pollTimer = window.setInterval(() => {
      void refreshDevices();
    }, 4_000);

    return () => {
      window.clearInterval(pollTimer);
    };
  }, [
    claimStatus,
    connectedDevices.length,
    initialClaimToken,
    recentPairingDeviceId,
    recentPairingDeviceRecord?.connected,
    refreshDevices,
    selectedDevice?.connected,
    selectedDeviceId,
  ]);

  useEffect(() => {
    if (initialClaimToken || pairingCode || creatingCode || !showAdvancedSetup) {
      return;
    }
    void handleGenerateCode();
  }, [creatingCode, initialClaimToken, pairingCode, showAdvancedSetup]);

  async function handleGenerateCode(): Promise<void> {
    setCreatingCode(true);
    setCopiedCommand(null);
    try {
      const response = await fetch("/api/bridge/devices/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => null) as PairingCodeResponse | null;
      if (!response.ok || !payload?.code) {
        throw new Error(payload?.error ?? `Failed to create pairing code (${response.status})`);
      }
      setPairingCode(payload.code);
      setExpiresIn(payload.expires_in ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pairing code.");
    } finally {
      setCreatingCode(false);
    }
  }

  async function handleCopyCommand(
    commandText: string,
    target: "setup" | "install" | "connect" | "manual",
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(commandText);
      setCopiedCommand(target);
      setError(null);
    } catch (err) {
      setCopiedCommand(null);
      setError(err instanceof Error ? err.message : "Failed to copy command.");
    }
  }

  async function handleDeleteDevice(deviceId: string): Promise<void> {
    setBusyDeviceId(deviceId);
    try {
      const response = await fetch(`/api/bridge/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to revoke device (${response.status})`);
      }
      await refreshDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke device.");
    } finally {
      setBusyDeviceId(null);
    }
  }

  async function handleRestartBridgeService(device: Device): Promise<void> {
    setServiceAction({
      deviceId: device.device_id,
      kind: "restart",
      status: "running",
      message: `Restarting the bridge service on ${device.device_name}.`,
    });

    try {
      const message = await requestBridgeServiceRestart(device.device_id);
      setServiceAction({
        deviceId: device.device_id,
        kind: "restart",
        status: "completed",
        message,
      });
      window.setTimeout(() => {
        void refreshDevices();
      }, 2_000);
    } catch (err) {
      setServiceAction({
        deviceId: device.device_id,
        kind: "restart",
        status: "failed",
        message: err instanceof Error ? err.message : `Failed to restart ${device.device_name}.`,
      });
    }
  }

  async function handleRepairBridge(device: Device): Promise<void> {
    setServiceAction({
      deviceId: device.device_id,
      kind: "repair",
      status: "running",
      message: `Reinstalling the bridge service on ${device.device_name}.`,
    });

    try {
      const message = await requestBridgeRepair(device.device_id, installScriptUrl);
      setServiceAction({
        deviceId: device.device_id,
        kind: "repair",
        status: "completed",
        message,
      });
      window.setTimeout(() => {
        void refreshDevices();
      }, 2_000);
    } catch (err) {
      setServiceAction({
        deviceId: device.device_id,
        kind: "repair",
        status: "failed",
        message: err instanceof Error ? err.message : `Failed to repair ${device.device_name}.`,
      });
    }
  }

  async function handleUpdateBridgeDevice(device: Device): Promise<void> {
    await runBridgeAutoUpdate(device, setPairingAutoUpdate);
    window.setTimeout(() => {
      void refreshDevices();
    }, 2_000);
  }

  async function handleOpenTestConnection(): Promise<void> {
    setTestConnectionOpen(true);
    setTestConnectionLoading(true);
    setTestConnectionError(null);
    setTestSession(null);

    try {
      const activeDevice = connectedDevices[0];
      if (!activeDevice) {
        throw new Error("Connect a laptop first, then reopen the device terminal test.");
      }

      const response = await fetch(
        withBridgeQuery("/api/sessions", activeDevice.device_id),
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null) as SessionsResponse | null;
      if (!response.ok) {
        const responseError = payload && !Array.isArray(payload) ? payload.error : null;
        throw new Error(responseError ?? `Failed to load sessions (${response.status})`);
      }

      const nextSession = pickBridgeTestSession(normalizeSessionsPayload(payload));
      if (!nextSession) {
        throw new Error("Create or resume a session first, then reopen the bridge terminal test.");
      }

      setTestSession(nextSession);
    } catch (err) {
      setTestConnectionError(err instanceof Error ? err.message : "Failed to load a session for bridge testing.");
    } finally {
      setTestConnectionLoading(false);
    }
  }

  return (
    <>
      <PublicPageShell className="py-8 sm:py-10">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          <Panel>
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <Eyebrow>Conductor Bridge</Eyebrow>
                <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-[var(--vk-text-strong)] sm:text-4xl">
                  Connect a laptop
                </h1>
                <p className="mt-3 text-base leading-7 text-[var(--vk-text-muted)]">
                  Pair one machine, keep the bridge daemon running on it, and use it from the normal
                  Conductor dashboard.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <StatPill>{devices.length} paired</StatPill>
                  <StatPill>{connectedDevices.length} online</StatPill>
                  <StatPill>
                    {readyDevice
                      ? `${readyDevice.device_name} ready`
                      : selectedDevice
                        ? `${selectedDevice.device_name} selected`
                        : "No device selected"}
                  </StatPill>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 lg:justify-end">
                {readyDashboardHref ? (
                  <Button asChild variant="primary" size="lg">
                    <Link href={readyDashboardHref}>
                      <Laptop className="h-4 w-4" />
                      Open {readyDevice?.device_name ?? "device"}
                    </Link>
                  </Button>
                ) : (
                  <Button asChild variant="primary" size="lg">
                    <a href="#bridge-setup">
                      <Laptop className="h-4 w-4" />
                      Set up this laptop
                    </a>
                  </Button>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => {
                    void refreshDevices();
                  }}
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={testConnectionLoading || connectedDevices.length === 0}
                  onClick={() => {
                    void handleOpenTestConnection();
                  }}
                >
                  {testConnectionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <TerminalSquare className="h-4 w-4" />}
                  Test connection
                </Button>
              </div>
            </div>
          </Panel>

          {readyDevice ? (
            <Panel className="border-[rgba(24,197,143,0.32)] bg-[rgba(24,197,143,0.08)] shadow-none">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <Eyebrow>Ready to use</Eyebrow>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--vk-text-strong)]">
                    {readyDevice.device_name} is online
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                    Continue into the dashboard with this laptop selected, or open a live bridge test.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="primary" size="lg">
                    <Link href={readyDashboardHref ?? "/"}>
                      <Laptop className="h-4 w-4" />
                      Open dashboard
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={() => {
                      void handleOpenTestConnection();
                    }}
                  >
                    <TerminalSquare className="h-4 w-4" />
                    Open terminal test
                  </Button>
                </div>
              </div>
            </Panel>
          ) : null}

          {error ? (
            <div className="rounded-[20px] border border-[color:color-mix(in_srgb,var(--vk-red)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-5 py-4 text-sm text-[var(--vk-red)]">
              {error}
            </div>
          ) : null}

          {initialClaimToken ? (
            <Panel>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <Eyebrow>Device-first pairing</Eyebrow>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--vk-text-strong)]">
                    {claimStatus === "paired" ? "This laptop is paired" : "Finishing this laptop claim"}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                    {claimStatus === "paired"
                      ? "The local command can now finish the handshake on the same machine. This page will keep refreshing until the laptop reports online."
                      : "Conductor is binding the currently-running machine to your account and returning device credentials to that local command."}
                  </p>
                </div>

                {claimedDevice ? (
                  <Button asChild variant="primary" size="lg">
                    <Link href={`/?bridge=${encodeURIComponent(claimedDevice.deviceId)}`}>
                      <Laptop className="h-4 w-4" />
                      Open {claimedDevice.deviceName}
                    </Link>
                  </Button>
                ) : null}
              </div>

              <div className="mt-5 rounded-[18px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-4 text-sm text-[var(--vk-text-muted)]">
                {claimStatus === "pending" ? (
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Waiting for the local command to receive its one-time device credentials.
                  </div>
                ) : claimStatus === "paired" && claimedDevice ? (
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-[var(--vk-green)]" />
                    <div>
                      <div className="font-medium text-[var(--vk-text-strong)]">{claimedDevice.deviceName} is now paired.</div>
                      <div className="mt-1">
                        {claimedDeviceRecord?.connected
                          ? "This laptop is online and ready to use."
                          : "The bridge service is restarting for this laptop now. This page will refresh until it reports online."}
                      </div>
                      {pairingAutoUpdate.message ? (
                        <div className={cn(
                          "mt-2 text-xs leading-5",
                          pairingAutoUpdate.phase === "failed"
                            ? "text-[var(--vk-red)]"
                            : pairingAutoUpdate.phase === "skipped"
                              ? "text-[var(--vk-text-muted)]"
                              : "text-[var(--vk-text-faint)]",
                        )}
                        >
                          {pairingAutoUpdate.message}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : claimError ? (
                  <div className="space-y-3">
                    <div className="text-[var(--vk-red)]">{claimError}</div>
                    <Button
                      type="button"
                      variant="outline"
                      size="md"
                      onClick={() => {
                        void completeClaim();
                      }}
                    >
                      <RefreshCw className="h-4 w-4" />
                      Retry claim
                    </Button>
                  </div>
                ) : null}
              </div>
            </Panel>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
            <Panel id="bridge-setup">
              <Eyebrow>Setup</Eyebrow>
              <h2 className="mt-2 text-xl font-semibold text-[var(--vk-text-strong)]">
                Connect this laptop
              </h2>
              <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                Most users only need one command. It installs the bridge, registers the background
                service, opens the browser, and pairs the current laptop to this dashboard.
              </p>

              <div className="mt-5">
                <CommandBlock
                  title="Recommended command"
                  description="Run this once on the laptop you want to use."
                  command={bootstrapConnectCommand}
                  footer={(
                    <Button
                      type="button"
                      variant="primary"
                      size="md"
                      onClick={() => {
                        void handleCopyCommand(bootstrapConnectCommand, "setup");
                      }}
                    >
                      {copiedCommand === "setup" ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copiedCommand === "setup" ? "Setup command copied" : "Copy setup command"}
                    </Button>
                  )}
                />
              </div>

              <ol className="mt-5 grid gap-3 sm:grid-cols-3">
                <li className="rounded-[18px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--vk-text-muted)]">
                    Step 1
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[var(--vk-text-normal)]">
                    Run the command in Terminal on the laptop you want to pair.
                  </p>
                </li>
                <li className="rounded-[18px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--vk-text-muted)]">
                    Step 2
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[var(--vk-text-normal)]">
                    Finish sign-in in the browser tab the command opens.
                  </p>
                </li>
                <li className="rounded-[18px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--vk-text-muted)]">
                    Step 3
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[var(--vk-text-normal)]">
                    Leave the bridge daemon running so the laptop stays available.
                  </p>
                </li>
              </ol>

              <div className="mt-5 rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)]">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                  onClick={() => {
                    setShowAdvancedSetup((current) => !current);
                  }}
                >
                  <div>
                    <div className="text-sm font-medium text-[var(--vk-text-strong)]">Advanced options</div>
                    <div className="mt-1 text-sm text-[var(--vk-text-muted)]">
                      Use these only if the default setup flow is not right for your case.
                    </div>
                  </div>
                  {showAdvancedSetup ? <ChevronUp className="h-4 w-4 text-[var(--vk-text-muted)]" /> : <ChevronDown className="h-4 w-4 text-[var(--vk-text-muted)]" />}
                </button>

                {showAdvancedSetup ? (
                  <div className="space-y-4 border-t border-[var(--vk-border)] px-4 py-4">
                    <CommandBlock
                      title="Install only"
                      description="Install the bridge now, then connect later from a new shell."
                      command={installCommand}
                      footer={(
                        <Button
                          type="button"
                          variant="outline"
                          size="md"
                          onClick={() => {
                            void handleCopyCommand(installCommand, "install");
                          }}
                        >
                          <Copy className="h-4 w-4" />
                          {copiedCommand === "install" ? "Install command copied" : "Copy install command"}
                        </Button>
                      )}
                    />

                    <CommandBlock
                      title="Already installed"
                      description="Use this when the bridge is already installed on the laptop."
                      command={connectCommand}
                      footer={(
                        <Button
                          type="button"
                          variant="outline"
                          size="md"
                          onClick={() => {
                            void handleCopyCommand(connectCommand, "connect");
                          }}
                        >
                          <Copy className="h-4 w-4" />
                          {copiedCommand === "connect" ? "Connect command copied" : "Copy connect command"}
                        </Button>
                      )}
                    />

                    <CommandBlock
                      title="Manual fallback"
                      description="Use a one-time code only if the browser claim flow cannot finish on the same machine."
                      command={manualCommand}
                      children={(
                        <div className="mt-4 rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--vk-text-muted)]">
                                One-time code
                              </div>
                              <div className="mt-3 font-mono text-4xl font-semibold tracking-[0.18em] text-[var(--vk-text-strong)]">
                                {pairingCode ?? "------"}
                              </div>
                              <div className="mt-3 text-sm text-[var(--vk-text-muted)]">
                                {pairingCode
                                  ? `Valid for about ${Math.max(1, Math.round((expiresIn ?? 600) / 60))} minutes.`
                                  : "Generate a code to reveal the manual pair command."}
                              </div>
                            </div>

                            <Button
                              type="button"
                              variant="outline"
                              size="md"
                              disabled={creatingCode}
                              onClick={() => {
                                void handleGenerateCode();
                              }}
                            >
                              {creatingCode ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                              {pairingCode ? "Generate new code" : "Generate code"}
                            </Button>
                          </div>
                        </div>
                      )}
                      footer={(
                        <Button
                          type="button"
                          variant="outline"
                          size="md"
                          disabled={!pairingCode}
                          onClick={() => {
                            void handleCopyCommand(manualCommand, "manual");
                          }}
                        >
                          {copiedCommand === "manual" ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          {copiedCommand === "manual" ? "Manual command copied" : "Copy manual command"}
                        </Button>
                      )}
                    />
                  </div>
                ) : null}
              </div>
            </Panel>

            <Panel>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Eyebrow>Devices</Eyebrow>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--vk-text-strong)]">
                    Paired devices
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                    Pick a laptop below, then continue into the dashboard with that device selected.
                  </p>
                </div>
                <StatPill>{devices.length} total</StatPill>
              </div>

              {selectedDevice ? (
                <div className="mt-5 rounded-[18px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-4">
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-base font-semibold text-[var(--vk-text-strong)]">
                        {selectedDevice.device_name}
                      </div>
                      <BridgeStatusPill
                        connected={selectedDevice.connected}
                        title={`${selectedDevice.device_name} is ${selectedDevice.connected ? "online" : "offline"}`}
                      />
                    </div>
                    <div className="text-sm text-[var(--vk-text-muted)]">
                      {formatDeviceDescriptor(selectedDevice)}
                    </div>
                    {pairingAutoUpdate.message && pairingAutoUpdate.deviceId === selectedDevice.device_id ? (
                      <div className={cn(
                        "text-xs leading-5",
                        pairingAutoUpdate.phase === "failed"
                          ? "text-[var(--vk-red)]"
                          : pairingAutoUpdate.phase === "skipped"
                            ? "text-[var(--vk-text-muted)]"
                            : "text-[var(--vk-text-faint)]",
                      )}
                      >
                        {pairingAutoUpdate.message}
                      </div>
                    ) : null}
                    {serviceAction.message && serviceAction.deviceId === selectedDevice.device_id ? (
                      <div className={cn(
                        "text-xs leading-5",
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
                    {selectedDeviceNeedsLocalRepair ? (
                      <BridgeLocalRepairNotice
                        deviceId={selectedDevice.device_id}
                        deviceName={selectedDevice.device_name}
                        dashboardUrl={dashboardUrl}
                        installScriptUrl={installScriptUrl}
                        relayUrl={relayUrl}
                      />
                    ) : null}
                    {selectedDevice.connected ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="md"
                          disabled={selectedDeviceActionRunning
                            || isBridgeAutoUpdateInFlight(pairingAutoUpdate, selectedDevice.device_id)}
                          onClick={() => {
                            void handleRepairBridge(selectedDevice);
                          }}
                        >
                          {selectedDeviceRepairRunning ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Wrench className="h-4 w-4" />
                          )}
                          Repair bridge
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="md"
                          disabled={isBridgeAutoUpdateInFlight(pairingAutoUpdate, selectedDevice.device_id)
                            || selectedDeviceActionRunning}
                          onClick={() => {
                            void handleUpdateBridgeDevice(selectedDevice);
                          }}
                        >
                          {isBridgeAutoUpdateInFlight(pairingAutoUpdate, selectedDevice.device_id) ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                          {isBridgeAutoUpdateInFlight(pairingAutoUpdate, selectedDevice.device_id) ? "Updating..." : "Update Conductor"}
                        </Button>
                        <Button asChild variant="primary" size="md">
                          <Link href={`/?bridge=${encodeURIComponent(selectedDevice.device_id)}`}>
                            <Laptop className="h-4 w-4" />
                            Continue with {selectedDevice.device_name}
                          </Link>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="md"
                          disabled={selectedDeviceActionRunning
                            || isBridgeAutoUpdateInFlight(pairingAutoUpdate, selectedDevice.device_id)}
                          onClick={() => {
                            void handleRestartBridgeService(selectedDevice);
                          }}
                        >
                          {selectedDeviceRestartRunning ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          Restart service
                        </Button>
                      </div>
                    ) : (
                      <div className="text-sm text-[var(--vk-text-muted)]">
                        This laptop is paired, but it is not online right now.
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              <div className="mt-5 space-y-3">
                {loading ? (
                  <div className="flex items-center gap-3 rounded-[18px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-4 text-sm text-[var(--vk-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading paired devices...
                  </div>
                ) : devices.length > 0 ? (
                  devices.map((device) => {
                    const isSelected = selectedDevice?.device_id === device.device_id;
                    const updateInFlight = isBridgeAutoUpdateInFlight(pairingAutoUpdate, device.device_id);
                    const serviceActionRunning = serviceAction.status === "running"
                      && serviceAction.deviceId === device.device_id;
                    const repairRunning = serviceActionRunning && serviceAction.kind === "repair";
                    const restartRunning = serviceActionRunning && serviceAction.kind === "restart";

                    return (
                      <div
                        key={device.device_id}
                        className={cn(
                          "rounded-[18px] border bg-[var(--vk-bg-main)] p-4",
                          isSelected ? "border-[var(--vk-orange)]" : "border-[var(--vk-border)]",
                        )}
                      >
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => {
                              setSelectedDeviceId(device.device_id);
                            }}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-base font-medium text-[var(--vk-text-strong)]">
                                {device.device_name}
                              </div>
                              <BridgeStatusPill
                                connected={device.connected}
                                title={`${device.device_name} is ${device.connected ? "online" : "offline"}`}
                              />
                              {isSelected ? (
                                <span className="rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 py-1 text-[11px] text-[var(--vk-text-muted)]">
                                  Selected
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-2 text-sm text-[var(--vk-text-muted)]">
                              {formatDeviceDescriptor(device)}
                            </div>
                            <div className="mt-1 text-xs text-[var(--vk-text-muted)]">
                              Relay: {device.last_status?.hostname ?? device.hostname}
                            </div>
                            {pairingAutoUpdate.message && pairingAutoUpdate.deviceId === device.device_id ? (
                              <div className={cn(
                                "mt-2 text-xs leading-5",
                                pairingAutoUpdate.phase === "failed"
                                  ? "text-[var(--vk-red)]"
                                  : pairingAutoUpdate.phase === "skipped"
                                    ? "text-[var(--vk-text-muted)]"
                                    : "text-[var(--vk-text-faint)]",
                              )}
                              >
                                {pairingAutoUpdate.message}
                              </div>
                            ) : null}
                            {serviceAction.message && serviceAction.deviceId === device.device_id ? (
                              <div className={cn(
                                "mt-2 text-xs leading-5",
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
                          </button>

                          <div className="flex shrink-0 items-center gap-2">
                            {device.connected ? (
                              <>
                                <Button asChild variant={isSelected ? "primary" : "outline"} size="md">
                                  <Link href={`/?bridge=${encodeURIComponent(device.device_id)}`}>
                                    {isSelected ? "Continue" : "Open"}
                                  </Link>
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="md"
                                  disabled={serviceActionRunning || updateInFlight}
                                  onClick={() => {
                                    setSelectedDeviceId(device.device_id);
                                    void handleRepairBridge(device);
                                  }}
                                >
                                  {repairRunning ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Wrench className="h-4 w-4" />
                                  )}
                                  Repair
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="md"
                                  disabled={updateInFlight || serviceActionRunning}
                                  onClick={() => {
                                    setSelectedDeviceId(device.device_id);
                                    void handleUpdateBridgeDevice(device);
                                  }}
                                >
                                  {updateInFlight ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Download className="h-4 w-4" />
                                  )}
                                  {updateInFlight ? "Updating..." : "Update"}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="md"
                                  disabled={serviceActionRunning || updateInFlight}
                                  onClick={() => {
                                    setSelectedDeviceId(device.device_id);
                                    void handleRestartBridgeService(device);
                                  }}
                                >
                                  {restartRunning ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <RefreshCw className="h-4 w-4" />
                                  )}
                                  Restart
                                </Button>
                              </>
                            ) : (
                              <span className="text-xs text-[var(--vk-text-muted)]">Offline</span>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={busyDeviceId === device.device_id}
                              onClick={() => {
                                void handleDeleteDevice(device.device_id);
                              }}
                              aria-label={`Revoke ${device.device_name}`}
                            >
                              {busyDeviceId === device.device_id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Trash2 className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="rounded-[18px] border border-dashed border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-6 text-sm text-[var(--vk-text-muted)]">
                    No laptops have been paired yet. Run the setup command on the laptop you want to use.
                  </div>
                )}
              </div>
            </Panel>
          </div>
        </div>
      </PublicPageShell>

      {testConnectionOpen ? (
        <div className="fixed inset-0 z-[85] flex items-start justify-center overflow-y-auto bg-black/70 px-3 py-3 sm:items-center sm:py-0">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Close bridge terminal test"
            onClick={() => {
              setTestConnectionOpen(false);
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bridge-test-title"
            className="relative z-10 flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_28px_80px_rgba(0,0,0,0.4)]"
          >
            <div className="flex flex-col gap-4 border-b border-[var(--vk-border)] px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--vk-text-muted)]">
                  Bridge terminal test
                </p>
                <h2 id="bridge-test-title" className="mt-2 text-xl font-semibold text-[var(--vk-text-strong)]">
                  Live session over Conductor Bridge
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--vk-text-muted)]">
                  {testSession
                    ? `${testSession.projectId}${testSession.branch ? ` · ${testSession.branch}` : ""}`
                    : "Open a session here to verify terminal input and output through the bridge."}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <BridgeStatusPill
                  connected={connectedDevices.length > 0}
                  title={`${connectedDevices.length} connected device${connectedDevices.length === 1 ? "" : "s"}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setTestConnectionOpen(false);
                  }}
                  aria-label="Close bridge test modal"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col px-5 py-5">
              {connectedDevices.length === 0 ? (
                <div className="mb-4 rounded-[18px] border border-[color:color-mix(in_srgb,var(--vk-red)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_10%,transparent)] px-4 py-3 text-sm text-[var(--vk-text-muted)]">
                  No paired bridge reports as online right now. Reconnect a laptop to test the live terminal path.
                </div>
              ) : null}

              {testConnectionLoading ? (
                <div className="flex min-h-[360px] flex-1 items-center justify-center rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-sm text-[var(--vk-text-muted)]">
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Preparing a session for the bridge test...
                  </div>
                </div>
              ) : testConnectionError ? (
                <div className="rounded-[20px] border border-[color:color-mix(in_srgb,var(--vk-red)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-5 py-4 text-sm text-[var(--vk-red)]">
                  {testConnectionError}
                </div>
              ) : testSession ? (
                <div className="min-h-[420px] flex-1 overflow-hidden rounded-[20px] border border-[var(--vk-border)] bg-[#060404]">
                  <SessionTerminal
                    sessionId={testSession.id}
                    bridgeId={testSession.bridgeId}
                    sessionState={testSession.status}
                    pendingInsert={null}
                  />
                </div>
              ) : (
                <div className="rounded-[20px] border border-dashed border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-5 py-10 text-sm text-[var(--vk-text-muted)]">
                  No session is available for bridge testing yet.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
