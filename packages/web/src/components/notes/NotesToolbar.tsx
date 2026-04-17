"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CalendarDays,
  ExternalLink,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Network,
  RefreshCcw,
  Save,
  Send,
  TriangleAlert,
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
  compact?: boolean;
  onOpenFiles?: () => void;
  onOpenShare?: () => void;
}

const BUTTON_CLASS_NAME = "inline-flex min-h-[34px] items-center gap-1.5 rounded-[6px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60";
const SEGMENT_CLASS_NAME = "inline-flex rounded-[6px] border border-[var(--vk-border)] p-0.5 text-[12px]";
const MENU_CONTENT_CLASS_NAME = "z-[120] min-w-[190px] rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-1 shadow-[0_20px_48px_rgba(0,0,0,0.35)]";
const MENU_ITEM_CLASS_NAME = "flex min-h-[36px] cursor-default items-center gap-2 rounded-[6px] px-3 text-[12px] text-[var(--vk-text-normal)] outline-none hover:bg-[var(--vk-bg-hover)] focus:bg-[var(--vk-bg-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-45";

function ViewModeSwitcher({
  compact,
  viewMode,
  onViewModeChange,
}: {
  compact: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}) {
  const options = compact
    ? (["edit", "preview"] as ViewMode[])
    : (["split", "edit", "preview"] as ViewMode[]);

  return (
    <div className={SEGMENT_CLASS_NAME}>
      {options.map((mode) => (
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
  );
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
  compact = false,
  onOpenFiles,
  onOpenShare,
}: NotesToolbarProps) {
  const saveDisabled = !selectedFile || !dirty || saving || fileTruncated;

  return (
    <div className="border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/50 px-3 py-2 sm:px-4">
      {compact ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenFiles}
            className={BUTTON_CLASS_NAME}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Files
          </button>

          <ViewModeSwitcher compact={compact} viewMode={viewMode} onViewModeChange={onViewModeChange} />

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

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className={BUTTON_CLASS_NAME}>
                <MoreHorizontal className="h-3.5 w-3.5" />
                More
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={8} className={MENU_CONTENT_CLASS_NAME}>
                <DropdownMenu.Item onSelect={onRefresh} className={MENU_ITEM_CLASS_NAME} disabled={indexLoading}>
                  {indexLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
                  Refresh
                </DropdownMenu.Item>
                {canSave ? (
                  <DropdownMenu.Item onSelect={onSave} className={MENU_ITEM_CLASS_NAME} disabled={saveDisabled}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item onSelect={onOpenExternally} className={MENU_ITEM_CLASS_NAME} disabled={!selectedFile || opening}>
                  {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                  Open in {editorName}
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={onDailyNote} className={MENU_ITEM_CLASS_NAME}>
                  <CalendarDays className="h-3.5 w-3.5" />
                  Today
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={onOpenShare} className={MENU_ITEM_CLASS_NAME}>
                  <Send className="h-3.5 w-3.5" />
                  Share note
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {dirty ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-[#f6c56f]">
              <TriangleAlert className="h-3.5 w-3.5" />
              Unsaved
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ViewModeSwitcher compact={compact} viewMode={viewMode} onViewModeChange={onViewModeChange} />

          <button type="button" onClick={onRefresh} disabled={indexLoading} className={BUTTON_CLASS_NAME}>
            {indexLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            Refresh
          </button>

          {canSave ? (
            <button type="button" onClick={onSave} disabled={saveDisabled} className={BUTTON_CLASS_NAME}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
          ) : null}

          <button type="button" onClick={onOpenExternally} disabled={!selectedFile || opening} className={BUTTON_CLASS_NAME}>
            {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
            Open in {editorName}
          </button>

          <button type="button" onClick={onDailyNote} className={BUTTON_CLASS_NAME}>
            <CalendarDays className="h-3.5 w-3.5" />
            Today
          </button>

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

          {dirty ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-[#f6c56f]">
              <TriangleAlert className="h-3.5 w-3.5" />
              Unsaved
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
