"use client";

import { useEffect, useState, useCallback } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import type { BacklinkInfo } from "./types";
import { withBridgeQuery } from "@/lib/bridgeQuery";

interface NotesBacklinksProps {
  projectId: string;
  bridgeId?: string | null;
  notePath: string | null;
  onNavigate: (path: string) => void;
}

export function NotesBacklinks({ projectId, bridgeId, notePath, onNavigate }: NotesBacklinksProps) {
  const [backlinks, setBacklinks] = useState<BacklinkInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const fetchBacklinks = useCallback(async () => {
    if (!notePath) {
      setBacklinks([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        projectId,
        path: notePath,
      });
      const response = await fetch(
        withBridgeQuery(`/api/project-notes/backlinks?${params.toString()}`, bridgeId),
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as
        | { backlinks?: BacklinkInfo[] }
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(
          payload && "error" in payload
            ? payload.error ?? "Failed to load backlinks"
            : `Failed to load backlinks (${response.status})`,
        );
      }

      const blPayload = payload as { backlinks?: BacklinkInfo[] } | null;
      setBacklinks(blPayload?.backlinks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backlinks");
      setBacklinks([]);
    } finally {
      setLoading(false);
    }
  }, [bridgeId, notePath, projectId]);

  useEffect(() => {
    void fetchBacklinks();
  }, [fetchBacklinks]);

  if (!notePath) return null;

  if (backlinks.length === 0 && !loading) return null;

  return (
    <div className="border-t border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="font-medium">
          Linked References
        </span>
        <span className="rounded-full bg-[var(--vk-bg-main)] px-2 py-0.5 text-[11px]">
          {backlinks.length}
        </span>
        {loading && (
          <span className="text-[11px] text-[var(--vk-text-muted)]">loading…</span>
        )}
      </button>

      {expanded && (
        <div className="max-h-[240px] overflow-auto px-4 pb-3">
          {error && (
            <p className="py-2 text-[12px] text-[var(--vk-red)]">{error}</p>
          )}
          {backlinks.map((bl) => (
            <button
              key={bl.path}
              type="button"
              onClick={() => onNavigate(bl.path)}
              className="flex w-full items-start gap-2 rounded-[4px] px-2 py-2 text-left hover:bg-[var(--vk-bg-hover)]"
            >
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-[var(--vk-text-normal)]">
                  {bl.name || bl.displayPath}
                </p>
                {bl.context && (
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-[var(--vk-text-muted)]">
                    {bl.context}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
