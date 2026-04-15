"use client";

import {
  ExternalLink,
  Loader2,
  Network,
  RefreshCcw,
  Save,
  TriangleAlert,
  CalendarDays,
} from "lucide-react";
import type { ViewMode } from "./types";

interface NotesToolbarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onSave: () => void;
  onRefresh: () => void;
  onOpenExternally: () => void;
  onDailyNote: () => void;
  onToggleGraph: () => void;
  graphOpen: boolean;
  saving: boolean;
  dirty: boolean;
  indexLoading: boolean;
  opening: boolean;
  selectedFile: { path: string; name: string } | null;
  fileTruncated: boolean;
  editorName?: string;
  canSave?: boolean;
}

export function NotesToolbar({
  viewMode,
  onViewModeChange,
  onSave,
  onRefresh,
  onOpenExternally,
  onDailyNote,
  onToggleGraph,
  graphOpen,
  saving,
  dirty,
  indexLoading,
  opening,
  selectedFile,
  fileTruncated,
  editorName = "editor",
  canSave = true,
}: NotesToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* View mode switcher */}
      <div className="inline-flex rounded-[6px] border border-[var(--vk-border)] p-0.5 text-[12px]">
        {(["split", "edit", "preview"] as ViewMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => onViewModeChange(mode)}
            className={`rounded-[4px] px-3 py-1.5 ${
              viewMode === mode
                ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
            }`}
          >
            {mode === "split" ? "Split" : mode === "edit" ? "Edit" : "Preview"}
          </button>
        ))}
      </div>

      {/* Refresh */}
      <button
        type="button"
        onClick={onRefresh}
        disabled={indexLoading}
        className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
      >
        {indexLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCcw className="h-3.5 w-3.5" />
        )}
        Refresh
      </button>

      {/* Save */}
      {canSave && (
        <button
          type="button"
          onClick={onSave}
          disabled={!selectedFile || !dirty || saving || fileTruncated}
          className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Save
        </button>
      )}

      {/* Open in editor */}
      <button
        type="button"
        onClick={onOpenExternally}
        disabled={!selectedFile || opening}
        className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
      >
        {opening ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ExternalLink className="h-3.5 w-3.5" />
        )}
        Open in {editorName}
      </button>

      {/* Today / Daily note */}
      <button
        type="button"
        onClick={onDailyNote}
        className="inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
      >
        <CalendarDays className="h-3.5 w-3.5" />
        Today
      </button>

      {/* Graph view toggle */}
      <button
        type="button"
        onClick={onToggleGraph}
        className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border px-3 text-[12px] hover:bg-[var(--vk-bg-hover)] ${
          graphOpen
            ? "border-[var(--vk-accent)] bg-[rgba(139,92,246,0.12)] text-[var(--vk-accent)]"
            : "border-[var(--vk-border)] text-[var(--vk-text-normal)]"
        }`}
      >
        <Network className="h-3.5 w-3.5" />
        Graph
      </button>

      {/* Unsaved changes indicator */}
      {dirty && (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-[#f6c56f]">
          <TriangleAlert className="h-3.5 w-3.5" />
          Unsaved
        </span>
      )}
    </div>
  );
}
