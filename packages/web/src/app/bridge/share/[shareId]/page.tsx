"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
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
      <main className="flex min-h-dvh items-center justify-center bg-[linear-gradient(180deg,#05070b_0%,#0a1018_100%)] px-6 text-white">
        <div className="rounded-[24px] border border-white/10 bg-white/5 px-6 py-5 text-sm text-white/70">
          Loading shared terminal…
        </div>
      </main>
    );
  }

  if (error || !sessionScope) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[linear-gradient(180deg,#05070b_0%,#0a1018_100%)] px-6 text-white">
        <div className="max-w-xl rounded-[24px] border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur">
          <p className="text-sm uppercase tracking-[0.24em] text-cyan-300">Conductor Bridge</p>
          <h1 className="mt-3 text-3xl font-semibold">Shared terminal unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-white/68">
            {error ?? "The shared terminal could not be resolved from this browser."}
          </p>
        </div>
      </main>
    );
  }

  const emptyInsert: TerminalInsertRequest | null = null;

  return (
    <main className="min-h-dvh bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.14),_transparent_35%),linear-gradient(180deg,#05070b_0%,#0a1018_100%)] px-3 py-3 text-white sm:px-6 sm:py-6">
      <div className="mx-auto flex min-h-[calc(100dvh-1.5rem)] w-full max-w-7xl flex-col overflow-hidden rounded-[28px] border border-white/10 bg-white/5 shadow-2xl backdrop-blur">
        <div className="border-b border-white/10 px-4 py-3 text-[12px] text-white/70 sm:px-6">
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
