"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Globe, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import type { PreviewStatusResponse } from "@/lib/previewTypes";

const PREVIEW_DISCOVERY_POLL_INTERVAL_MS = 5_000;

interface SessionPreviewProps {
  sessionId: string;
  active: boolean;
}

export function SessionPreview({ sessionId, active }: SessionPreviewProps) {
  const [status, setStatus] = useState<PreviewStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeNonce, setIframeNonce] = useState(0);

  const previewUrl = useMemo(
    () => status?.currentUrl ?? status?.candidateUrls[0] ?? null,
    [status],
  );

  const loadStatus = useCallback(async (mode: "load" | "refresh" = "load") => {
    if (mode === "load") {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/preview`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as
        | PreviewStatusResponse
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(
          payload && "error" in payload
            ? payload.error ?? "Failed to load preview"
            : `Failed to load preview: ${response.status}`,
        );
      }

      const nextStatus = payload as PreviewStatusResponse;
      setStatus(nextStatus);
      setError(nextStatus.lastError);
    } catch (loadError) {
      setStatus(null);
      setError(loadError instanceof Error ? loadError.message : "Failed to load preview");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setStatus(null);
    setError(null);
    setLoading(true);
    setRefreshing(false);
    setIframeNonce(0);
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    void loadStatus("load");

    if (previewUrl) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadStatus("refresh");
    }, PREVIEW_DISCOVERY_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [active, loadStatus, previewUrl]);

  const handleRefresh = useCallback(() => {
    setIframeNonce((current) => current + 1);
    void loadStatus("refresh");
  }, [loadStatus]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-1.5 sm:p-0">
      <Card className="min-h-0 flex-1 overflow-hidden">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-[var(--vk-text-muted)]" />
              <span className="text-[13px] font-medium text-[var(--vk-text-normal)]">Preview</span>
            </div>
            <p className="mt-1 truncate text-[12px] text-[var(--vk-text-muted)]">
              {previewUrl ?? "Waiting for a preview URL"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={loading || refreshing}
            >
              {refreshing
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
            {previewUrl ? (
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[var(--vk-border)] px-3 text-[12px] font-medium text-[var(--vk-text-normal)] transition hover:bg-[var(--vk-bg-hover)]"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </a>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="min-h-0">
          {loading ? (
            <div className="flex h-[72vh] min-h-[360px] items-center justify-center rounded-[8px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[13px] text-[var(--vk-text-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading preview…
            </div>
          ) : previewUrl ? (
            <div className="h-[72vh] min-h-[360px] overflow-hidden rounded-[8px] border border-[var(--vk-border)] bg-white">
              <iframe
                key={`${previewUrl}:${iframeNonce}`}
                src={previewUrl}
                title={`Preview for session ${sessionId}`}
                className="h-full w-full border-0 bg-white"
              />
            </div>
          ) : (
            <div className="flex h-[72vh] min-h-[360px] items-center justify-center rounded-[8px] border border-dashed border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-6 text-center text-[13px] text-[var(--vk-text-muted)]">
              No preview URL was detected for this session yet. Start the project dev server or expose a preview URL in session metadata.
            </div>
          )}
        </CardContent>
      </Card>
      {error ? (
        <div className="flex items-start gap-2 rounded-[6px] border border-[color:color-mix(in_srgb,var(--vk-red)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--vk-red)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--vk-red)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
