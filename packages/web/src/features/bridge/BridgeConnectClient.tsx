"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Copy,
  ExternalLink,
  Laptop,
  Loader2,
  RefreshCw,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { SessionTerminal } from "@/components/sessions/SessionTerminal";
import { BridgeStatusPill } from "@/components/bridge/BridgeStatusPill";
import { Button } from "@/components/ui/Button";
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
      <main className="min-h-dvh bg-[var(--vk-bg-main)] px-6 py-8 text-[var(--vk-text-normal)]">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <section className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--vk-text-muted)]">
                  Conductor Bridge
                </p>
                <div>
                  <h1 className="text-2xl font-semibold text-[var(--vk-text-strong)]">Connect a laptop</h1>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--vk-text-muted)]">
                    Pair a laptop once, keep the bridge daemon running on it, and use it as a real execution target from the normal Conductor dashboard.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
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
                  disabled={testConnectionLoading}
                  onClick={() => {
                    void handleOpenTestConnection();
                  }}
                >
                  {testConnectionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <TerminalSquare className="h-4 w-4" />}
                  Test Connection
                </Button>
              </div>
            </div>
          </section>

          {error ? (
            <section className="rounded-[20px] border border-[color:color-mix(in_srgb,var(--vk-red)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-5 py-4 text-sm text-[var(--vk-red)]">
              {error}
            </section>
          ) : null}

          {initialClaimToken ? (
            <section className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--vk-text-muted)]">
                    Device-First Pairing
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--vk-text-strong)]">
                    {claimStatus === "paired" ? "This laptop is paired" : "Finishing this laptop claim"}
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--vk-text-muted)]">
                    {claimStatus === "paired"
                      ? "The command that opened this page can now finish the relay handshake on the same machine. Open the dashboard with this device selected once it reports online."
                      : "Sign-in completed. Conductor is binding the currently-running machine to your dashboard account and handing the device token back to that local command."}
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

              <div className="mt-5 rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-5 py-4 text-sm text-[var(--vk-text-muted)]">
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
                        Conductor is restarting the background bridge service for this laptop now.
                        This page will refresh automatically until the device reports online.
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
            </section>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <section className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--vk-text-strong)]">Connect this laptop</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                    New users should only need one command. It installs the bridge, registers the
                    background service, opens the browser, and pairs the current laptop to this
                    dashboard.
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-1.5 text-xs text-[var(--vk-text-muted)]">
                  <BridgeStatusPill connected={connectedDevices.length > 0} title={`${connectedDevices.length} connected device${connectedDevices.length === 1 ? "" : "s"}`} />
                  <span>{connectedDevices.length > 0 ? "Bridge online" : "Bridge not connected yet"}</span>
                </div>
              </div>

              <div className="mt-6 rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
                      Recommended setup
                    </div>
                    <h3 className="mt-2 text-base font-semibold text-[var(--vk-text-strong)]">
                      Install and connect in one step
                    </h3>
                    <p className="mt-3 text-sm leading-6 text-[var(--vk-text-muted)]">
                      Run this once on the laptop you want to use. The script installs the bridge,
                      registers its background service, and immediately launches the device-claim
                      flow for this dashboard.
                    </p>
                  </div>
                  <span className="rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-1.5 text-xs font-medium text-[var(--vk-text-muted)]">
                    One command
                  </span>
                </div>
                <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3 font-mono text-sm leading-6 text-[var(--vk-text-normal)]">
                  {bootstrapConnectCommand}
                </pre>
                <div className="mt-4 flex flex-wrap gap-2">
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    onClick={() => {
                      setShowAdvancedSetup((current) => !current);
                    }}
                  >
                    {showAdvancedSetup ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    {showAdvancedSetup ? "Hide advanced options" : "Show advanced/manual options"}
                  </Button>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--vk-text-muted)]">
                      1. Run once
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                      Paste the command into Terminal on the laptop you want to pair.
                    </p>
                  </div>
                  <div className="rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--vk-text-muted)]">
                      2. Sign in
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                      The command opens this browser flow and preserves the claim token automatically.
                    </p>
                  </div>
                  <div className="rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--vk-text-muted)]">
                      3. Stay online
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                      After pairing, the bridge daemon keeps this laptop available in the dashboard.
                    </p>
                  </div>
                </div>
              </div>

              {showAdvancedSetup ? (
                <div className="mt-4 space-y-4">
                  <div className="rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-5">
                    <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
                      Install only
                    </div>
                    <p className="mt-3 text-sm leading-6 text-[var(--vk-text-muted)]">
                      Use this if you want to install the bridge first and run connect later from a
                      new shell.
                    </p>
                    <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3 font-mono text-sm leading-6 text-[var(--vk-text-normal)]">
                      {installCommand}
                    </pre>
                    <div className="mt-4 flex flex-wrap gap-2">
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
                    </div>
                  </div>

                  <div className="rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-5">
                    <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
                      Already installed
                    </div>
                    <p className="mt-3 text-sm leading-6 text-[var(--vk-text-muted)]">
                      If the bridge is already present on this laptop, rerun the direct connect
                      command instead of reinstalling it.
                    </p>
                    <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3 font-mono text-sm leading-6 text-[var(--vk-text-normal)]">
                      {connectCommand}
                    </pre>
                    <div className="mt-4 flex flex-wrap gap-2">
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
                    </div>
                  </div>

                  <div className="rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
                          Manual fallback
                        </div>
                        <p className="mt-3 text-sm leading-6 text-[var(--vk-text-muted)]">
                          Use a one-time code only if the browser claim flow cannot finish on the
                          same machine.
                        </p>
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
                        {pairingCode ? "Generate a new code" : "Generate a code"}
                      </Button>
                    </div>
                    <div className="mt-4 rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
                        One-time code
                      </div>
                      <div className="mt-3 font-mono text-4xl font-semibold tracking-[0.18em] text-[var(--vk-text-strong)]">
                        {pairingCode ?? "------"}
                      </div>
                      <div className="mt-3 text-sm text-[var(--vk-text-muted)]">
                        {pairingCode
                          ? `Valid for about ${Math.max(1, Math.round((expiresIn ?? 600) / 60))} minutes and invalid after the first successful pair.`
                          : 'Generate a code to reveal the manual pair command.'}
                      </div>
                    </div>
                    <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3 font-mono text-sm leading-6 text-[var(--vk-text-normal)]">
                      {manualCommand}
                    </pre>
                    <div className="mt-4 flex flex-wrap gap-2">
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
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--vk-text-strong)]">Paired devices</h2>
                  <p className="mt-2 text-sm text-[var(--vk-text-muted)]">
                    Online status comes from the live bridge websocket. Revoking a device removes its refresh token on the relay side.
                  </p>
                </div>
                <span className="rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-1.5 text-xs text-[var(--vk-text-muted)]">
                  {devices.length} paired
                </span>
              </div>

              <div className="mt-6 space-y-3">
                {loading ? (
                  <div className="flex items-center gap-3 rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-4 text-sm text-[var(--vk-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading paired devices...
                  </div>
                ) : devices.length > 0 ? (
                  devices.map((device) => (
                    <div
                      key={device.device_id}
                      className="rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium text-[var(--vk-text-strong)]">
                              {device.device_name}
                            </p>
                            <BridgeStatusPill connected={device.connected} title={`${device.device_name} is ${device.connected ? "online" : "offline"}`} />
                          </div>
                          <p className="mt-2 text-xs text-[var(--vk-text-muted)]">
                            {device.hostname} · {device.os}/{device.arch}
                          </p>
                          <p className="mt-1 text-xs text-[var(--vk-text-muted)]">
                            Relay status: {device.last_status?.hostname ?? device.hostname}
                          </p>
                        </div>

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
                  ))
                ) : (
                  <div className="rounded-[20px] border border-dashed border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-4 py-6 text-sm text-[var(--vk-text-muted)]">
                    No laptops have been paired yet. Run the one-line setup command on the laptop
                    you want to claim, then finish the browser sign-in it opens.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>

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
