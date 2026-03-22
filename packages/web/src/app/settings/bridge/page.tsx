"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BRIDGE_RELAY_URL_STORAGE_KEY,
  BRIDGE_TOKEN_STORAGE_KEY,
} from "@/types/bridge";
import {
  buildBridgeHttpUrl,
  clearBridgeSettings,
  readBridgeSettings,
} from "@/lib/bridge";

type RelayBridge = {
  bridge_id: string;
  browser_count: number;
  connected: boolean;
  last_status: {
    hostname: string;
    os: string;
    connected: boolean;
  } | null;
};

type RelayShare = {
  share_id: string;
  session_scope: string;
  browser_url: string;
  read_only: boolean;
  created_at_secs: number;
};

type BridgesResponse = {
  bridges?: RelayBridge[];
  error?: string;
};

type SharesResponse = {
  shares?: RelayShare[];
  error?: string;
};

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function BridgeSettingsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [bridges, setBridges] = useState<RelayBridge[]>([]);
  const [shares, setShares] = useState<RelayShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const relayHttpUrl = useMemo(() => {
    if (!relayUrl) return null;
    const url = buildBridgeHttpUrl("/health");
    return url ? new URL(url).origin : null;
  }, [relayUrl]);

  async function refresh() {
    const settings = readBridgeSettings();
    setToken(settings.token);
    setRelayUrl(settings.relayUrl);

    try {
      const [bridgesResponse, sharesResponse] = await Promise.all([
        fetch("/api/bridge/bridges", { cache: "no-store" }),
        fetch("/api/bridge/shares", { cache: "no-store" }),
      ]);

      const bridgePayload = (await bridgesResponse.json().catch(() => null)) as BridgesResponse | null;
      const sharePayload = (await sharesResponse.json().catch(() => null)) as SharesResponse | null;
      if (!bridgesResponse.ok) {
        throw new Error(bridgePayload?.error ?? `Failed to load bridges (${bridgesResponse.status})`);
      }
      if (!sharesResponse.ok) {
        throw new Error(sharePayload?.error ?? `Failed to load shares (${sharesResponse.status})`);
      }
      setBridges(bridgePayload?.bridges ?? []);
      setShares(sharePayload?.shares ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load bridge settings.");
      setBridges([]);
      setShares([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const hasStoredToken = Boolean(token);

  return (
    <main className="min-h-dvh bg-[var(--vk-bg-main)] px-6 py-8 text-[var(--vk-text-normal)]">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <div className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold">Bridge settings</h1>
              <p className="mt-2 text-sm text-[var(--vk-text-muted)]">
                Manage the local bridge token, relay URL, connected bridges, and shared terminal links.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/bridge/connect"
                className="rounded-xl border border-[var(--vk-border)] px-4 py-2 text-sm hover:bg-[var(--vk-bg-hover)]"
              >
                Connect bridge
              </Link>
              <button
                type="button"
                onClick={() => {
                  void refresh();
                }}
                className="rounded-xl border border-[var(--vk-border)] px-4 py-2 text-sm hover:bg-[var(--vk-bg-hover)]"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
            <h2 className="text-lg font-semibold">Local connection</h2>
            <dl className="mt-4 space-y-4 text-sm">
              <div>
                <dt className="text-[var(--vk-text-muted)]">Relay URL</dt>
                <dd className="mt-1 break-all font-mono text-xs text-[var(--vk-text-normal)]">
                  {relayUrl ?? "not configured"}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--vk-text-muted)]">Bridge token</dt>
                <dd className="mt-1 break-all font-mono text-xs text-[var(--vk-text-normal)]">
                  {token ?? "not configured"}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--vk-text-muted)]">Storage keys</dt>
                <dd className="mt-1 break-all font-mono text-xs text-[var(--vk-text-normal)]">
                  {BRIDGE_TOKEN_STORAGE_KEY}, {BRIDGE_RELAY_URL_STORAGE_KEY}
                </dd>
              </div>
            </dl>
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  clearBridgeSettings();
                  setToken(null);
                  setRelayUrl(null);
                  setBridges([]);
                  setShares([]);
                }}
                className="rounded-xl border border-[var(--vk-border)] px-4 py-2 text-sm hover:bg-[var(--vk-bg-hover)]"
              >
                Revoke local token
              </button>
              <button
                type="button"
                onClick={() => {
                  void refresh();
                }}
                className="rounded-xl border border-[var(--vk-border)] px-4 py-2 text-sm hover:bg-[var(--vk-bg-hover)]"
              >
                Reload relay state
              </button>
            </div>
          </section>

          <section className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
            <h2 className="text-lg font-semibold">Relay status</h2>
            <p className="mt-2 text-sm text-[var(--vk-text-muted)]">
              {relayHttpUrl ? `Relay origin: ${relayHttpUrl}` : "No relay configured in this browser."}
            </p>
            <div className="mt-4 space-y-3">
              {bridges.length > 0 ? (
                bridges.map((bridge) => (
                  <div key={bridge.bridge_id} className="rounded-2xl border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-4 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">
                          {bridge.last_status?.hostname ?? bridge.bridge_id}
                        </div>
                        <div className="mt-1 text-xs text-[var(--vk-text-muted)]">
                          {bridge.last_status?.os ?? "unknown"} · {bridge.browser_count} browser connection{bridge.browser_count === 1 ? "" : "s"}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busyId === bridge.bridge_id}
                        onClick={async () => {
                          setBusyId(bridge.bridge_id);
                          try {
                            const response = await fetch(`/api/bridge/bridges/${encodeURIComponent(bridge.bridge_id)}`, {
                              method: "DELETE",
                            });
                            if (!response.ok) {
                              throw new Error(`Failed to revoke bridge (${response.status})`);
                            }
                            await refresh();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : "Failed to revoke bridge.");
                          } finally {
                            setBusyId(null);
                          }
                        }}
                        className="rounded-xl border border-[var(--vk-border)] px-3 py-1.5 text-xs hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-[var(--vk-border)] px-4 py-6 text-sm text-[var(--vk-text-muted)]">
                  {loading ? "Loading bridge list…" : "No connected bridges found."}
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="rounded-[24px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Shared terminals</h2>
              <p className="mt-1 text-sm text-[var(--vk-text-muted)]">
                Read-only links are created and revoked on the relay. They never store session output.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {shares.length > 0 ? (
              shares.map((share) => (
                <div key={share.share_id} className="rounded-2xl border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-4 text-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="font-medium">Share {share.share_id.slice(0, 8)}</div>
                      <div className="mt-1 text-xs text-[var(--vk-text-muted)]">
                        Session scope: {share.session_scope} · {share.read_only ? "read-only" : "editable"} · created {formatAge(share.created_at_secs)}
                      </div>
                      <div className="mt-1 break-all font-mono text-[11px] text-[var(--vk-text-muted)]">
                        {share.browser_url}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busyId === share.share_id}
                      onClick={async () => {
                        setBusyId(share.share_id);
                        try {
                          const response = await fetch(`/api/bridge/shares/${encodeURIComponent(share.share_id)}`, {
                            method: "DELETE",
                          });
                          if (!response.ok) {
                            throw new Error(`Failed to revoke share (${response.status})`);
                          }
                          await refresh();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Failed to revoke share.");
                        } finally {
                          setBusyId(null);
                        }
                      }}
                      className="rounded-xl border border-[var(--vk-border)] px-3 py-1.5 text-xs hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--vk-border)] px-4 py-6 text-sm text-[var(--vk-text-muted)]">
                {loading ? "Loading share links…" : "No active shared terminals."}
              </div>
            )}
          </div>
        </section>

        {error ? (
          <div className="rounded-[24px] border border-[rgba(255,143,122,0.25)] bg-[rgba(255,143,122,0.08)] px-5 py-4 text-sm text-[var(--status-error)]">
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}
