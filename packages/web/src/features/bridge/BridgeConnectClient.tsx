"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Laptop,
  Loader2,
  RefreshCw,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { BridgeStatusPill } from "@/components/bridge/BridgeStatusPill";
import { PublicPageShell } from "@/components/public/PublicPageShell";
import { SessionTerminal } from "@/components/sessions/SessionTerminal";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
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

function BridgeSurface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-[30px] border border-[rgba(255,255,255,0.08)]",
        "bg-[linear-gradient(180deg,rgba(18,18,23,0.96),rgba(9,9,13,0.98))]",
        "shadow-[0_28px_70px_rgba(0,0,0,0.34)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

function SectionEyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--vk-text-muted)]", className)}>
      {children}
    </p>
  );
}

function MetricTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint: string;
  tone?: "default" | "success" | "warning";
}) {
  const toneClasses = {
    default: "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]",
    success: "border-[rgba(24,197,143,0.24)] bg-[rgba(24,197,143,0.08)]",
    warning: "border-[rgba(244,179,124,0.22)] bg-[rgba(244,179,124,0.08)]",
  };

  return (
    <div className={cn("rounded-[20px] border px-4 py-4 backdrop-blur-sm", toneClasses[tone])}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-[var(--vk-text-strong)]">
        {value}
      </div>
      <div className="mt-1 text-xs text-[var(--vk-text-muted)]">{hint}</div>
    </div>
  );
}

function StepTile({
  step,
  title,
  description,
}: {
  step: string;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-[20px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-4 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
        {step}
      </div>
      <div className="mt-2 text-base font-semibold text-[var(--vk-text-strong)]">{title}</div>
      <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">{description}</p>
    </div>
  );
}

function CommandPanel({
  eyebrow,
  title,
  description,
  command,
  badge,
  headerAction,
  children,
  footer,
  className,
  commandClassName,
}: {
  eyebrow: string;
  title: string;
  description: string;
  command: string;
  badge?: ReactNode;
  headerAction?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  commandClassName?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[24px] border border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-5",
        className,
      )}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <SectionEyebrow className="tracking-[0.24em]">{eyebrow}</SectionEyebrow>
          <h3 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-[var(--vk-text-strong)]">{title}</h3>
          <p className="mt-3 text-sm leading-7 text-[var(--vk-text-muted)]">{description}</p>
        </div>
        {badge || headerAction ? (
          <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
            {badge}
            {headerAction}
          </div>
        ) : null}
      </div>
      {children}
      <pre
        className={cn(
          "mt-5 overflow-x-auto whitespace-pre-wrap break-all rounded-[18px] border border-[rgba(255,255,255,0.08)]",
          "bg-[#09090d] px-4 py-4 font-mono text-sm leading-7 text-[var(--vk-text-normal)]",
          commandClassName,
        )}
      >
        {command}
      </pre>
      {footer ? <div className="mt-4">{footer}</div> : null}
    </div>
  );
}

const HERO_PRIMARY_BUTTON_CLASS = [
  "min-w-[220px] justify-center rounded-[16px] border-[#846548]",
  "bg-[linear-gradient(135deg,rgba(244,179,124,0.22),rgba(198,138,92,0.14))]",
  "text-[#fff0dd] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
  "hover:bg-[linear-gradient(135deg,rgba(244,179,124,0.28),rgba(198,138,92,0.2))]",
].join(" ");

const HERO_SECONDARY_BUTTON_CLASS = [
  "rounded-[16px] border-[rgba(255,255,255,0.12)] bg-white/[0.03]",
  "text-[var(--vk-text-normal)] hover:bg-white/[0.08]",
].join(" ");

export default function BridgeConnectClient({
  initialClaimToken = null,
  dashboardUrl,
  relayUrl,
  installScriptUrl,
}: {
  initialClaimToken?: string | null;
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
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

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
  const selectedDevice = useMemo(
    () => devices.find((device) => device.device_id === selectedDeviceId)
      ?? claimedDeviceRecord
      ?? connectedDevices[0]
      ?? devices[0]
      ?? null,
    [claimedDeviceRecord, connectedDevices, devices, selectedDeviceId],
  );
  const readyDevice = useMemo(
    () => (claimedDeviceRecord?.connected ? claimedDeviceRecord : null)
      ?? (selectedDevice?.connected ? selectedDevice : null)
      ?? connectedDevices[0]
      ?? null,
    [claimedDeviceRecord, connectedDevices, selectedDevice],
  );
  const readyDashboardHref = readyDevice
    ? `/?bridge=${encodeURIComponent(readyDevice.device_id)}`
    : null;
  const spotlightDevice = readyDevice ?? selectedDevice;
  const flowState = initialClaimToken
    ? claimStatus === "paired"
      ? "Claim linked"
      : "Claim pending"
    : showAdvancedSetup
      ? "Advanced view"
      : "One-step setup";

  const heroTitle = readyDevice
    ? `${readyDevice.device_name} is online and ready`
    : spotlightDevice
      ? `${spotlightDevice.device_name} is paired but offline`
      : "No paired laptop yet";

  const heroDescription = readyDevice
    ? "Jump back into the dashboard with this machine selected, or open a live bridge test session to verify the terminal transport."
    : spotlightDevice
      ? "Conductor already knows about this laptop, but it is not currently reporting online. Restart the local bridge service on that machine to make it available again."
      : "Run the one-step setup command below on the laptop you want to use. It installs the bridge, opens this sign-in flow, and claims the machine automatically.";

  useEffect(() => {
    setSelectedDeviceId((current) => {
      if (current && devices.some((device) => device.device_id === current)) {
        return current;
      }
      return claimedDeviceRecord?.device_id
        ?? connectedDevices[0]?.device_id
        ?? devices[0]?.device_id
        ?? null;
    });
  }, [claimedDeviceRecord, connectedDevices, devices]);

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
    if (!initialClaimToken && !(claimStatus === "paired" && connectedDevices.length === 0)) {
      return;
    }

    const pollTimer = window.setInterval(() => {
      void refreshDevices();
    }, 4_000);

    return () => {
      window.clearInterval(pollTimer);
    };
  }, [claimStatus, connectedDevices.length, initialClaimToken, refreshDevices]);

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

  async function handleOpenTestConnection(): Promise<void> {
    setTestConnectionOpen(true);
    setTestConnectionLoading(true);
    setTestConnectionError(null);
    setTestSession(null);

    try {
      const activeDevice = (selectedDevice?.connected ? selectedDevice : null)
        ?? readyDevice
        ?? connectedDevices[0];
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
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <BridgeSurface className="p-0">
            <div className="grid xl:grid-cols-[minmax(0,1.12fr)_360px]">
              <div className="relative overflow-hidden px-6 py-7 sm:px-8 sm:py-8">
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(244,179,124,0.18),transparent_46%),radial-gradient(circle_at_bottom_left,rgba(95,151,255,0.1),transparent_40%)]" />
                <div className="relative">
                  <SectionEyebrow>Conductor Bridge</SectionEyebrow>
                  <h1 className="mt-4 max-w-3xl font-brand-display text-3xl uppercase tracking-[0.05em] text-[var(--vk-text-strong)] sm:text-4xl xl:text-[2.75rem]">
                    Connect a laptop once. Keep it ready for work.
                  </h1>
                  <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--vk-text-muted)] sm:text-lg">
                    Pair a real machine to this dashboard, keep the bridge daemon running, and use
                    it like a native execution target whenever you need local context or hardware.
                  </p>

                  <div className="mt-7 grid gap-3 sm:grid-cols-3">
                    <MetricTile
                      label="Paired devices"
                      value={devices.length}
                      hint={devices.length === 1 ? "One laptop claimed" : "Total laptops claimed"}
                    />
                    <MetricTile
                      label="Online now"
                      value={connectedDevices.length}
                      hint={connectedDevices.length > 0 ? "Ready for dashboard use" : "No live bridge connection"}
                      tone={connectedDevices.length > 0 ? "success" : "warning"}
                    />
                    <MetricTile
                      label="Setup state"
                      value={flowState}
                      hint={initialClaimToken ? "Device-first claim flow" : "Pairing path"}
                      tone={initialClaimToken ? "success" : "default"}
                    />
                  </div>

                  <div className="mt-7 flex flex-wrap gap-3">
                    {readyDashboardHref ? (
                      <Button asChild variant="primary" size="lg" className={HERO_PRIMARY_BUTTON_CLASS}>
                        <Link href={readyDashboardHref}>
                          <Laptop className="h-4 w-4" />
                          Open {readyDevice?.device_name ?? "selected laptop"}
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="primary"
                        size="lg"
                        className={HERO_PRIMARY_BUTTON_CLASS}
                        onClick={() => {
                          void handleCopyCommand(bootstrapConnectCommand, "setup");
                        }}
                      >
                        {copiedCommand === "setup" ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        {copiedCommand === "setup" ? "Setup command copied" : "Copy setup command"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      className={HERO_SECONDARY_BUTTON_CLASS}
                      onClick={() => {
                        void refreshDevices();
                      }}
                    >
                      <RefreshCw className="h-4 w-4" />
                      Refresh status
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      className={HERO_SECONDARY_BUTTON_CLASS}
                      disabled={testConnectionLoading}
                      onClick={() => {
                        void handleOpenTestConnection();
                      }}
                    >
                      {testConnectionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <TerminalSquare className="h-4 w-4" />}
                      Test bridge session
                    </Button>
                  </div>
                </div>
              </div>

              <div className="border-t border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] px-6 py-7 sm:px-8 sm:py-8 xl:border-l xl:border-t-0">
                <SectionEyebrow>Current Status</SectionEyebrow>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <BridgeStatusPill
                    connected={Boolean(spotlightDevice?.connected)}
                    title={spotlightDevice
                      ? `${spotlightDevice.device_name} is ${spotlightDevice.connected ? "online" : "offline"}`
                      : "No paired laptop yet"}
                  />
                  <span className="text-sm text-[var(--vk-text-muted)]">
                    {connectedDevices.length > 0
                      ? `${connectedDevices.length} laptop${connectedDevices.length === 1 ? "" : "s"} online`
                      : devices.length > 0
                        ? "Waiting for a paired laptop to reconnect"
                        : "Ready to pair a first laptop"}
                  </span>
                </div>
                <h2 className="mt-5 text-2xl font-semibold tracking-[-0.03em] text-[var(--vk-text-strong)]">
                  {heroTitle}
                </h2>
                <p className="mt-3 text-sm leading-7 text-[var(--vk-text-muted)]">
                  {heroDescription}
                </p>

                {spotlightDevice ? (
                  <div
                    className={cn(
                      "mt-5 rounded-[24px] border p-5",
                      spotlightDevice.connected
                        ? "border-[rgba(24,197,143,0.24)] bg-[rgba(24,197,143,0.08)]"
                        : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <SectionEyebrow className="tracking-[0.22em]">
                          {spotlightDevice.connected ? "Ready device" : "Selected device"}
                        </SectionEyebrow>
                        <div className="mt-2 text-lg font-semibold text-[var(--vk-text-strong)]">
                          {spotlightDevice.device_name}
                        </div>
                      </div>
                      <BridgeStatusPill
                        connected={spotlightDevice.connected}
                        title={`${spotlightDevice.device_name} is ${spotlightDevice.connected ? "online" : "offline"}`}
                      />
                    </div>
                    <div className="mt-4 space-y-2 text-sm text-[var(--vk-text-muted)]">
                      <p>{formatDeviceDescriptor(spotlightDevice)}</p>
                      <p>Relay sees {spotlightDevice.last_status?.hostname ?? spotlightDevice.hostname}</p>
                    </div>
                    {spotlightDevice.connected ? (
                      <div className="mt-5">
                        <Button asChild variant="primary" size="lg" className={HERO_PRIMARY_BUTTON_CLASS}>
                          <Link href={`/?bridge=${encodeURIComponent(spotlightDevice.device_id)}`}>
                            <ExternalLink className="h-4 w-4" />
                            Continue into dashboard
                          </Link>
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-5 rounded-[24px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-5">
                    <SectionEyebrow className="tracking-[0.22em]">Default flow</SectionEyebrow>
                    <div className="mt-3 space-y-3 text-sm leading-6 text-[var(--vk-text-muted)]">
                      <p>1. Run the one-step setup command on the laptop you want to use.</p>
                      <p>2. Finish sign-in in the browser tab that command opens.</p>
                      <p>3. Leave the bridge daemon running so the laptop stays selectable.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </BridgeSurface>

          {error ? (
            <div className="rounded-[22px] border border-[color:color-mix(in_srgb,var(--vk-red)_32%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-5 py-4 text-sm text-[var(--vk-red)]">
              {error}
            </div>
          ) : null}

          {initialClaimToken ? (
            <BridgeSurface className="border-[rgba(95,151,255,0.2)] bg-[linear-gradient(135deg,rgba(95,151,255,0.12),rgba(255,255,255,0.02))] px-6 py-6 sm:px-7">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <SectionEyebrow>Device-First Pairing</SectionEyebrow>
                  <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-[var(--vk-text-strong)]">
                    {claimStatus === "paired" ? "This laptop is paired" : "Finishing this laptop claim"}
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-[var(--vk-text-muted)]">
                    {claimStatus === "paired"
                      ? "The local command that opened this browser can now finish the relay handshake on the same machine. This page will keep refreshing until the laptop reports online."
                      : "Sign-in completed. Conductor is binding the currently-running machine to your dashboard account and handing the device token back to that local command."}
                  </p>
                </div>
                {claimedDevice ? (
                  <Button asChild variant="primary" size="lg" className={HERO_PRIMARY_BUTTON_CLASS}>
                    <Link href={`/?bridge=${encodeURIComponent(claimedDevice.deviceId)}`}>
                      <Laptop className="h-4 w-4" />
                      {claimedDeviceRecord?.connected ? `Open ${claimedDevice.deviceName}` : `View ${claimedDevice.deviceName}`}
                    </Link>
                  </Button>
                ) : null}
              </div>

              <div className="mt-5 rounded-[22px] border border-[rgba(255,255,255,0.08)] bg-[rgba(9,9,13,0.52)] px-5 py-4 text-sm text-[var(--vk-text-muted)]">
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
                          ? "The laptop is online. Use the button above to return to the dashboard with this device already selected."
                          : "Conductor is restarting the background bridge service for this laptop now. This panel will refresh until it reports online."}
                      </div>
                    </div>
                  </div>
                ) : claimError ? (
                  <div className="space-y-3">
                    <div className="text-[var(--vk-red)]">{claimError}</div>
                    <Button
                      type="button"
                      variant="outline"
                      size="md"
                      className={HERO_SECONDARY_BUTTON_CLASS}
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
            </BridgeSurface>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.12fr)_minmax(320px,0.88fr)]">
            <BridgeSurface className="px-6 py-6 sm:px-7">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-2xl">
                  <SectionEyebrow>Pair This Laptop</SectionEyebrow>
                  <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-[var(--vk-text-strong)]">
                    Install, claim, and stay available
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-[var(--vk-text-muted)]">
                    Most users only need one command. It installs the bridge, registers the background
                    service, opens the browser, and links the current laptop to this dashboard.
                  </p>
                </div>
                <div className="rounded-[22px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-4 py-4">
                  <SectionEyebrow className="tracking-[0.22em]">Bridge availability</SectionEyebrow>
                  <div className="mt-3 flex items-center gap-2">
                    <BridgeStatusPill
                      connected={connectedDevices.length > 0}
                      title={`${connectedDevices.length} connected device${connectedDevices.length === 1 ? "" : "s"}`}
                    />
                    <span className="text-sm text-[var(--vk-text-muted)]">
                      {connectedDevices.length > 0 ? "At least one laptop is live" : "No live bridge yet"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-6">
                <CommandPanel
                  eyebrow="Recommended path"
                  title="Install, register, and claim this laptop"
                  description="Run this on the machine you want to use. It handles install, background service setup, and the browser claim flow in one shot."
                  command={bootstrapConnectCommand}
                  badge={(
                    <span className="rounded-full border border-[rgba(244,179,124,0.28)] bg-[rgba(244,179,124,0.1)] px-3 py-1.5 text-xs font-medium text-[#f4d2a8]">
                      One command
                    </span>
                  )}
                  footer={(
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="primary"
                        size="md"
                        className={HERO_PRIMARY_BUTTON_CLASS}
                        onClick={() => {
                          void handleCopyCommand(bootstrapConnectCommand, "setup");
                        }}
                      >
                        {copiedCommand === "setup" ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        {copiedCommand === "setup" ? "Setup command copied" : "Copy setup command"}
                      </Button>
                    </div>
                  )}
                />
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <StepTile
                  step="Step 1"
                  title="Run it once"
                  description="Paste the command into Terminal on the laptop you want to claim."
                />
                <StepTile
                  step="Step 2"
                  title="Finish sign-in"
                  description="The command opens the browser and carries the claim token automatically."
                />
                <StepTile
                  step="Step 3"
                  title="Leave bridge running"
                  description="The background daemon keeps the laptop available from the main dashboard."
                />
              </div>

              <div className="mt-6 overflow-hidden rounded-[24px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-4 px-5 py-5 text-left transition-colors hover:bg-white/[0.03]"
                  onClick={() => {
                    setShowAdvancedSetup((current) => !current);
                  }}
                >
                  <div>
                    <SectionEyebrow className="tracking-[0.22em]">Advanced options</SectionEyebrow>
                    <div className="mt-2 text-lg font-semibold text-[var(--vk-text-strong)]">
                      Install-only, reconnect, or use a one-time code
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                      Keep this collapsed unless you need a non-default setup path.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-[var(--vk-text-muted)]">
                    <span>{showAdvancedSetup ? "Hide" : "Show"}</span>
                    {showAdvancedSetup ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </button>

                {showAdvancedSetup ? (
                  <div className="border-t border-[rgba(255,255,255,0.08)] px-4 py-4 sm:px-5 sm:py-5">
                    <div className="space-y-4">
                      <CommandPanel
                        eyebrow="Install only"
                        title="Install the bridge without pairing yet"
                        description="Use this if you want the binary and background service in place first, then run connect later from a new shell."
                        command={installCommand}
                        footer={(
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="md"
                              className={HERO_SECONDARY_BUTTON_CLASS}
                              onClick={() => {
                                void handleCopyCommand(installCommand, "install");
                              }}
                            >
                              <Copy className="h-4 w-4" />
                              {copiedCommand === "install" ? "Install command copied" : "Copy install command"}
                            </Button>
                          </div>
                        )}
                      />

                      <CommandPanel
                        eyebrow="Already installed"
                        title="Reconnect a laptop that already has bridge"
                        description="If the bridge is already present on the laptop, rerun the direct connect command instead of reinstalling it."
                        command={connectCommand}
                        footer={(
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="md"
                              className={HERO_SECONDARY_BUTTON_CLASS}
                              onClick={() => {
                                void handleCopyCommand(connectCommand, "connect");
                              }}
                            >
                              <Copy className="h-4 w-4" />
                              {copiedCommand === "connect" ? "Connect command copied" : "Copy connect command"}
                            </Button>
                          </div>
                        )}
                      />

                      <CommandPanel
                        eyebrow="Manual fallback"
                        title="Use a one-time code only when browser claim cannot finish"
                        description="Generate a short-lived pairing code if the command and browser cannot complete on the same machine."
                        command={manualCommand}
                        headerAction={(
                          <Button
                            type="button"
                            variant="outline"
                            size="md"
                            className={HERO_SECONDARY_BUTTON_CLASS}
                            disabled={creatingCode}
                            onClick={() => {
                              void handleGenerateCode();
                            }}
                          >
                            {creatingCode ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            {pairingCode ? "Generate new code" : "Generate code"}
                          </Button>
                        )}
                        footer={(
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="md"
                              className={HERO_SECONDARY_BUTTON_CLASS}
                              disabled={!pairingCode}
                              onClick={() => {
                                void handleCopyCommand(manualCommand, "manual");
                              }}
                            >
                              {copiedCommand === "manual" ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                              {copiedCommand === "manual" ? "Manual command copied" : "Copy manual command"}
                            </Button>
                          </div>
                        )}
                      >
                        <div className="mt-5 rounded-[18px] border border-[rgba(255,255,255,0.08)] bg-[#09090d] px-4 py-4">
                          <SectionEyebrow className="tracking-[0.22em]">One-time code</SectionEyebrow>
                          <div className="mt-3 font-mono text-4xl font-semibold tracking-[0.18em] text-[var(--vk-text-strong)]">
                            {pairingCode ?? "------"}
                          </div>
                          <div className="mt-3 text-sm text-[var(--vk-text-muted)]">
                            {pairingCode
                              ? `Valid for about ${Math.max(1, Math.round((expiresIn ?? 600) / 60))} minutes and consumed after the first successful pair.`
                              : "Generate a code to reveal the manual pair command."}
                          </div>
                        </div>
                      </CommandPanel>
                    </div>
                  </div>
                ) : null}
              </div>
            </BridgeSurface>

            <BridgeSurface className="px-6 py-6 sm:px-7">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-xl">
                  <SectionEyebrow>Paired Devices</SectionEyebrow>
                  <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-[var(--vk-text-strong)]">
                    Choose the laptop Conductor should use
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-[var(--vk-text-muted)]">
                    Select any paired laptop below, then continue into the dashboard with that
                    machine scoped in. Revoking a device removes its relay refresh token.
                  </p>
                </div>
                <div className="rounded-[22px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-4 py-4 text-left sm:text-right">
                  <SectionEyebrow className="tracking-[0.22em]">Inventory</SectionEyebrow>
                  <div className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-[var(--vk-text-strong)]">
                    {devices.length}
                  </div>
                  <div className="text-xs text-[var(--vk-text-muted)]">
                    {connectedDevices.length} online now
                  </div>
                </div>
              </div>

              {selectedDevice ? (
                <div
                  className={cn(
                    "mt-6 rounded-[24px] border p-5",
                    selectedDevice.connected
                      ? "border-[rgba(24,197,143,0.24)] bg-[rgba(24,197,143,0.08)]"
                      : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]",
                  )}
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <SectionEyebrow className="tracking-[0.22em]">Selected device</SectionEyebrow>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <div className="text-xl font-semibold text-[var(--vk-text-strong)]">
                          {selectedDevice.device_name}
                        </div>
                        <BridgeStatusPill
                          connected={selectedDevice.connected}
                          title={`${selectedDevice.device_name} is ${selectedDevice.connected ? "online" : "offline"}`}
                        />
                      </div>
                      <div className="mt-3 text-sm leading-7 text-[var(--vk-text-muted)]">
                        <p>{formatDeviceDescriptor(selectedDevice)}</p>
                        <p>Relay sees {selectedDevice.last_status?.hostname ?? selectedDevice.hostname}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selectedDevice.connected ? (
                        <Button asChild variant="primary" size="lg" className={HERO_PRIMARY_BUTTON_CLASS}>
                          <Link href={`/?bridge=${encodeURIComponent(selectedDevice.device_id)}`}>
                            <ExternalLink className="h-4 w-4" />
                            Continue with {selectedDevice.device_name}
                          </Link>
                        </Button>
                      ) : (
                        <div className="rounded-[16px] border border-[rgba(255,255,255,0.08)] bg-[rgba(9,9,13,0.45)] px-4 py-3 text-sm text-[var(--vk-text-muted)]">
                          This laptop is paired, but it is not online right now.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="mt-5">
                {loading ? (
                  <div className="flex items-center gap-3 rounded-[22px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-4 py-4 text-sm text-[var(--vk-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading paired devices...
                  </div>
                ) : devices.length > 0 ? (
                  <div className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
                    {devices.map((device) => {
                      const isSelected = selectedDevice?.device_id === device.device_id;

                      return (
                        <div
                          key={device.device_id}
                          className={cn(
                            "rounded-[24px] border p-4 transition-all",
                            isSelected
                              ? "border-[rgba(244,179,124,0.34)] bg-[linear-gradient(180deg,rgba(244,179,124,0.1),rgba(255,255,255,0.02))] shadow-[0_0_0_1px_rgba(244,179,124,0.08)]"
                              : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)]",
                          )}
                        >
                          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => {
                                setSelectedDeviceId(device.device_id);
                              }}
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="truncate text-base font-semibold text-[var(--vk-text-strong)]">
                                  {device.device_name}
                                </p>
                                <BridgeStatusPill
                                  connected={device.connected}
                                  title={`${device.device_name} is ${device.connected ? "online" : "offline"}`}
                                />
                                {isSelected ? (
                                  <span className="rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] px-2.5 py-1 text-[11px] text-[var(--vk-text-muted)]">
                                    Selected
                                  </span>
                                ) : null}
                              </div>
                              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                <div className="rounded-[18px] border border-[rgba(255,255,255,0.08)] bg-[rgba(9,9,13,0.42)] px-4 py-3">
                                  <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--vk-text-muted)]">
                                    Machine
                                  </div>
                                  <div className="mt-1 text-sm text-[var(--vk-text-normal)]">
                                    {formatDeviceDescriptor(device)}
                                  </div>
                                </div>
                                <div className="rounded-[18px] border border-[rgba(255,255,255,0.08)] bg-[rgba(9,9,13,0.42)] px-4 py-3">
                                  <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--vk-text-muted)]">
                                    Relay sees
                                  </div>
                                  <div className="mt-1 text-sm text-[var(--vk-text-normal)]">
                                    {device.last_status?.hostname ?? device.hostname}
                                  </div>
                                </div>
                              </div>
                            </button>

                            <div className="flex shrink-0 items-center gap-2">
                              {device.connected ? (
                                <Button
                                  asChild
                                  variant={isSelected ? "primary" : "outline"}
                                  size="md"
                                  className={isSelected ? HERO_PRIMARY_BUTTON_CLASS : HERO_SECONDARY_BUTTON_CLASS}
                                >
                                  <Link href={`/?bridge=${encodeURIComponent(device.device_id)}`}>
                                    {isSelected ? "Continue" : "Open"}
                                  </Link>
                                </Button>
                              ) : (
                                <span className="rounded-full border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] px-3 py-2 text-xs text-[var(--vk-text-muted)]">
                                  Offline
                                </span>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="rounded-[14px] border border-[rgba(210,81,81,0.24)] bg-[rgba(210,81,81,0.04)] text-[var(--vk-red)] hover:bg-[rgba(210,81,81,0.14)] hover:text-[var(--vk-red)]"
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
                    })}
                  </div>
                ) : (
                  <div className="rounded-[22px] border border-dashed border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.02)] px-4 py-6 text-sm leading-7 text-[var(--vk-text-muted)]">
                    No laptops have been paired yet. Run the one-step setup command on the machine
                    you want to claim, then complete the browser sign-in it opens.
                  </div>
                )}
              </div>
            </BridgeSurface>
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
                  Bridge Terminal Test
                </p>
                <h2 id="bridge-test-title" className="mt-2 text-xl font-semibold text-[var(--vk-text-strong)]">
                  Live session over Conductor Bridge
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--vk-text-muted)]">
                  {testSession
                    ? `${testSession.projectId}${testSession.branch ? ` · ${testSession.branch}` : ""}`
                    : "Open a session in this modal to verify websocket transport, streamed output, and interactive terminal input through the bridge."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <BridgeStatusPill
                  connected={connectedDevices.length > 0}
                  title={`${connectedDevices.length} connected device${connectedDevices.length === 1 ? "" : "s"}`}
                />
                {testSession ? (
                  <Button asChild variant="outline" size="md">
                    <Link href={`/sessions/${encodeURIComponent(testSession.id)}`}>
                      <ExternalLink className="h-4 w-4" />
                      Open session
                    </Link>
                  </Button>
                ) : null}
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
                  No paired bridge reports as online right now. You can still open the terminal test, but the bridge connection will remain offline until a laptop reconnects.
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
