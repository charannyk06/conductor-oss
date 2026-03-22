"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Laptop,
  Loader2,
  Plus,
  RefreshCw,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { SessionTerminal } from "@/components/sessions/SessionTerminal";
import { BridgeStatusPill } from "@/components/bridge/BridgeStatusPill";
import { Button } from "@/components/ui/Button";
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
}: {
  initialClaimToken?: string | null;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingCode, setCreatingCode] = useState(false);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [testConnectionOpen, setTestConnectionOpen] = useState(false);
  const [testConnectionLoading, setTestConnectionLoading] = useState(false);
  const [testConnectionError, setTestConnectionError] = useState<string | null>(null);
  const [testSession, setTestSession] = useState<DashboardSession | null>(null);
  const [claimStatus, setClaimStatus] = useState<"idle" | "pending" | "paired">(
    initialClaimToken ? "pending" : "idle",
  );
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimedDevice, setClaimedDevice] = useState<{ deviceId: string; deviceName: string } | null>(null);

  const command = useMemo(() => (
    pairingCode
      ? `conductor-bridge pair --code ${pairingCode}\nconductor-bridge daemon`
      : "conductor-bridge pair --code ABC123\nconductor-bridge daemon"
  ), [pairingCode]);
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
    if (initialClaimToken || pairingCode || creatingCode) {
      return;
    }
    void handleGenerateCode();
  }, [creatingCode, initialClaimToken, pairingCode]);

  async function handleGenerateCode(): Promise<void> {
    setCreatingCode(true);
    setCopyState("idle");
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

  async function handleCopyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
      setError(null);
    } catch (err) {
      setCopyState("error");
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
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  disabled={creatingCode}
                  onClick={() => {
                    void handleGenerateCode();
                  }}
                >
                  {creatingCode ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {pairingCode ? "Generate a new code" : "Add a laptop"}
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
                        Leave the local `conductor-bridge connect` command running so the device comes online immediately.
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
                  <h2 className="text-lg font-semibold text-[var(--vk-text-strong)]">Pairing code</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--vk-text-muted)]">
                    Generate a one-time code, run the commands on the laptop, and the bridge will store its refresh token at{" "}
                    <code className="rounded bg-[var(--vk-bg-main)] px-1.5 py-0.5 text-[12px] text-[var(--vk-text-normal)]">
                      ~/.conductor/bridge-refresh-token
                    </code>
                    . Keep the daemon running so the laptop stays online in the dashboard.
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-1.5 text-xs text-[var(--vk-text-muted)]">
                  <BridgeStatusPill connected={connectedDevices.length > 0} title={`${connectedDevices.length} connected device${connectedDevices.length === 1 ? "" : "s"}`} />
                  <span>{pairingCode ? "Ready to pair" : "Generate a code"}</span>
                </div>
              </div>

              <div className="mt-6 rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
                  One-time code
                </div>
                <div className="mt-3 font-mono text-4xl font-semibold tracking-[0.18em] text-[var(--vk-text-strong)]">
                  {pairingCode ?? "------"}
                </div>
                <div className="mt-3 text-sm text-[var(--vk-text-muted)]">
                  {pairingCode
                    ? `Valid for about ${Math.max(1, Math.round((expiresIn ?? 600) / 60))} minutes and invalid after the first successful pair.`
                    : 'Click "Add a laptop" to mint the next pairing code.'}
                </div>
              </div>

              <div className="mt-4 rounded-[20px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--vk-text-muted)]">
                  Command to run
                </div>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-[16px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-4 py-3 font-mono text-sm leading-6 text-[var(--vk-text-normal)]">
                  {command}
                </pre>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="md"
                    disabled={!pairingCode}
                    onClick={() => {
                      void handleCopyCommand();
                    }}
                  >
                    {copyState === "copied" ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copyState === "copied" ? "Command copied" : "Copy command"}
                  </Button>
                </div>
              </div>
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
                    No laptops have been paired yet. Generate a code, run the bridge command on a machine, and it will appear here.
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
