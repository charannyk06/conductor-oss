"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { PublicPageShell, PublicPanel, PublicSection } from "@/components/public/PublicPageShell";

type ShareRecord = {
  share_id: string;
  read_only: boolean;
  created_at_secs: number;
};

type ShareOutputResponse = {
  output?: string;
  error?: string;
};

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function BridgeSharePage() {
  const params = useParams<{ shareId: string }>();
  const shareId = params.shareId;
  const mountedRef = useRef(true);
  const [share, setShare] = useState<ShareRecord | null>(null);
  const [output, setOutput] = useState("");
  const [loadingShare, setLoadingShare] = useState(true);
  const [refreshingOutput, setRefreshingOutput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const loadOutput = useCallback(async (background = false) => {
    if (!background && mountedRef.current) {
      setRefreshingOutput(true);
    }

    try {
      const response = await fetch(
        `/api/bridge/shares/${encodeURIComponent(shareId)}/output?lines=500`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as ShareOutputResponse | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Failed to load shared terminal output (${response.status})`);
      }

      if (!mountedRef.current) {
        return;
      }

      setOutput(typeof payload?.output === "string" ? payload.output : "");
      setError(null);
      setLastUpdatedAt(new Date().toLocaleTimeString());
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load shared terminal output.");
      }
    } finally {
      if (!background && mountedRef.current) {
        setRefreshingOutput(false);
      }
    }
  }, [shareId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadShare() {
      setLoadingShare(true);
      try {
        const response = await fetch(`/api/bridge/shares/${encodeURIComponent(shareId)}`, {
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as
          | (ShareRecord & { error?: string })
          | null;
        if (!response.ok) {
          throw new Error(payload?.error ?? `Failed to resolve share link (${response.status})`);
        }

        if (cancelled || !mountedRef.current) {
          return;
        }

        setShare(payload);
        setError(null);
        await loadOutput();
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          setError(err instanceof Error ? err.message : "Failed to resolve share link.");
        }
      } finally {
        if (!cancelled && mountedRef.current) {
          setLoadingShare(false);
        }
      }
    }

    void loadShare();
    return () => {
      cancelled = true;
    };
  }, [loadOutput, shareId]);

  useEffect(() => {
    if (!share) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadOutput(true);
    }, 4000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadOutput, share]);

  if (loadingShare) {
    return (
      <PublicPageShell className="flex items-center">
        <div className="mx-auto w-full max-w-xl">
          <PublicPanel className="px-6 py-5 text-sm text-[var(--text-muted)]">Loading shared terminal...</PublicPanel>
        </div>
      </PublicPageShell>
    );
  }

  if (error && !share) {
    return (
      <PublicPageShell className="flex items-center">
        <div className="mx-auto w-full max-w-xl">
          <PublicPanel className="p-6">
            <PublicSection
              eyebrow="Conductor Bridge"
              title="Shared terminal unavailable"
              description={error}
            />
          </PublicPanel>
        </div>
      </PublicPageShell>
    );
  }

  return (
    <main className="min-h-dvh bg-[var(--bg-canvas)] px-3 py-3 text-[var(--text-strong)] sm:px-6 sm:py-6">
      <div className="mx-auto flex min-h-[calc(100dvh-1.5rem)] w-full max-w-7xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-soft)] bg-[var(--bg-panel)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-soft)] px-4 py-3 text-[12px] text-[var(--text-muted)] sm:px-6">
          <div>
            Shared terminal
            {share ? ` · ${share.read_only ? "read-only" : "editable"} · created ${formatAge(share.created_at_secs)}` : ""}
          </div>
          <div className="flex items-center gap-3">
            {lastUpdatedAt ? <span>Updated {lastUpdatedAt}</span> : null}
            <button
              type="button"
              onClick={() => {
                void loadOutput();
              }}
              disabled={refreshingOutput}
              className="rounded-md border border-[var(--border-soft)] px-2 py-1 text-[11px] text-[var(--text-strong)] hover:bg-[var(--bg-panel-elevated)] disabled:opacity-60"
            >
              {refreshingOutput ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
        {error ? (
          <div className="border-b border-[var(--border-soft)] bg-[rgba(255,143,122,0.08)] px-4 py-2 text-[12px] text-[var(--status-error)] sm:px-6">
            {error}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto bg-[#060404] p-4 sm:p-6">
          <pre className="min-h-full whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-[#efe8e1]">
            {output || "No terminal output is available yet."}
          </pre>
        </div>
      </div>
    </main>
  );
}
