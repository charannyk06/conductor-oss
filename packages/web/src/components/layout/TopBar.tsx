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
    <header className="oc-mobile-touch-target flex h-11 shrink-0 items-center border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)] pl-14 pr-2 text-[12px] text-[var(--vk-text-muted)] sm:h-[33px] sm:pl-5 sm:pr-5 sm:text-[13px]">
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
          className="oc-mobile-touch-target inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] sm:h-8 sm:w-8"
          aria-label="Open Conductor support"
          title="Support"
        >
          <LifeBuoy className="h-4 w-4" />
        </a>
        {onOpenPreferences ? (
          <button
            type="button"
            onClick={onOpenPreferences}
            className="oc-mobile-touch-target inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] sm:h-8 sm:w-8"
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
