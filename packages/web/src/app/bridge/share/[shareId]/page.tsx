"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PublicPageShell, PublicPanel, PublicSection } from "@/components/public/PublicPageShell";
import { BridgeSessionTerminal } from "@/components/bridge/BridgeSessionTerminal";
import type { TerminalInsertRequest } from "@/components/sessions/terminalInsert";
import { buildBridgeHttpUrl, hasBridgeSettings } from "@/lib/bridge";

type ShareRecord = {
  share_id: string;
  session_scope: string;
  browser_url?: string;
  read_only?: boolean;
};

type ShareListResponse = {
  shares?: ShareRecord[];
};

export default function BridgeSharePage() {
  const params = useParams<{ shareId: string }>();
  const shareId = params.shareId;
  const [sessionScope, setSessionScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadShare() {
      if (!hasBridgeSettings()) {
        if (!cancelled) {
          setError("Bridge settings are not configured in this browser.");
          setLoading(false);
        }
        return;
      }

      const url = buildBridgeHttpUrl("/api/shares");
      if (!url) {
        if (!cancelled) {
          setError("Bridge relay URL is invalid.");
          setLoading(false);
        }
        return;
      }

      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Failed to load share links (${response.status})`);
        }

        const payload = (await response.json().catch(() => null)) as ShareListResponse | null;
        const share = payload?.shares?.find((item) => item.share_id === shareId) ?? null;
        if (!share) {
          throw new Error("Share link not found.");
        }

        if (!cancelled) {
          setSessionScope(share.session_scope);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to resolve share link.");
          setLoading(false);
        }
      }
    }

    void loadShare();
    return () => {
      cancelled = true;
    };
  }, [shareId]);

  if (loading) {
    return (
      <PublicPageShell className="flex items-center">
        <div className="mx-auto w-full max-w-xl">
          <PublicPanel className="px-6 py-5 text-sm text-[var(--text-muted)]">Loading shared terminal...</PublicPanel>
        </div>
      </PublicPageShell>
    );
  }

  if (error || !sessionScope) {
    return (
      <PublicPageShell className="flex items-center">
        <div className="mx-auto w-full max-w-xl">
          <PublicPanel className="p-6">
            <PublicSection
              eyebrow="Conductor Bridge"
              title="Shared terminal unavailable"
              description={error ?? "The shared terminal could not be resolved from this browser."}
            />
          </PublicPanel>
        </div>
      </PublicPageShell>
    );
  }

  const emptyInsert: TerminalInsertRequest | null = null;

  return (
    <main className="min-h-dvh bg-[var(--bg-canvas)] px-3 py-3 text-[var(--text-strong)] sm:px-6 sm:py-6">
      <div className="mx-auto flex min-h-[calc(100dvh-1.5rem)] w-full max-w-7xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-soft)] bg-[var(--bg-panel)]">
        <div className="border-b border-[var(--border-soft)] px-4 py-3 text-[12px] text-[var(--text-muted)] sm:px-6">
          Read-only shared terminal
        </div>
        <div className="min-h-0 flex-1">
          <BridgeSessionTerminal
            sessionId={sessionScope}
            sessionState="shared"
            pendingInsert={emptyInsert}
            immersiveMobileMode={false}
            scope={`share-${shareId}`}
            readOnly
          />
        </div>
      </div>
    </main>
  );
}
