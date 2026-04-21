"use client";

import { memo, type ReactNode } from "react";
import { LifeBuoy, Settings } from "lucide-react";
import { CONDUCTOR_SUPPORT_DISCUSSIONS_URL } from "@/lib/supportLinks";

interface TopBarProps {
  title?: string;
  onOpenPreferences?: () => void;
  rightContent?: ReactNode;
}

export const TopBar = memo(function TopBar({ title, onOpenPreferences, rightContent }: TopBarProps) {
  return (
    <header className="flex h-[33px] items-center border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)] pl-14 pr-2 text-[12px] text-[var(--vk-text-muted)] sm:pl-5 sm:pr-5 sm:text-[13px]">
      <div className="min-w-0 flex-1 text-left sm:text-center">
        <span className="block truncate font-medium tracking-[0.01em] text-[var(--vk-text-muted)]">
          {title ?? "All Projects"}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {rightContent ? (
          <div className="flex items-center gap-1.5">
            {rightContent}
          </div>
        ) : null}
        <a
          href={CONDUCTOR_SUPPORT_DISCUSSIONS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
          aria-label="Open Conductor support"
          title="Support"
        >
          <LifeBuoy className="h-4 w-4" />
        </a>
        {onOpenPreferences ? (
          <button
            type="button"
            onClick={onOpenPreferences}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]"
            aria-label="Open preferences"
            title="Preferences"
          >
            <Settings className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </header>
  );
});
