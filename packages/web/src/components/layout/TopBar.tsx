"use client";

import { Settings } from "lucide-react";
import type { DashboardSession } from "@/lib/types";

interface TopBarProps {
  session: DashboardSession | null;
  fallbackTitle?: string;
  onOpenPreferences?: () => void;
}

export function TopBar({ session, fallbackTitle, onOpenPreferences }: TopBarProps) {
  const title = session?.summary ?? fallbackTitle ?? "Create Workspace";

  return (
    <header className="flex h-[33px] items-center border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[11px] text-[var(--vk-text-muted)]">
      <div className="w-[33%]" />
      <div className="flex w-[34%] items-center justify-center">
        <span className="truncate">{title}</span>
      </div>
      <div className="flex w-[33%] justify-end">
        <button
          type="button"
          onClick={onOpenPreferences}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
          aria-label="Open preferences"
          title="Preferences"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
