"use client";

import { memo } from "react";
import { Settings } from "lucide-react";

interface TopBarProps {
  title?: string;
  onOpenPreferences?: () => void;
}

export const TopBar = memo(function TopBar({ title, onOpenPreferences }: TopBarProps) {
  return (
    <header className="flex h-11 items-center border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)] pl-12 pr-3 text-[13px] text-[var(--vk-text-muted)] sm:h-14 sm:px-5 sm:text-[14px]">
      <div className="min-w-0 flex-1 text-left sm:text-center">
        <span className="block truncate font-medium tracking-[0.01em] text-[var(--vk-text-normal)]">
          {title ?? "All Projects"}
        </span>
      </div>
      {onOpenPreferences ? (
        <div className="ml-1 flex shrink-0">
          <button
            type="button"
            onClick={onOpenPreferences}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[6px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
            aria-label="Open preferences"
            title="Preferences"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </header>
  );
});
