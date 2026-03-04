"use client";

import type { DashboardSession } from "@/lib/types";

interface TopBarProps {
  session: DashboardSession | null;
  fallbackTitle?: string;
}

export function TopBar({ session, fallbackTitle }: TopBarProps) {
  const title = session?.summary ?? fallbackTitle ?? "Create Workspace";

  return (
    <header className="flex h-[33px] items-center border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[11px] text-[var(--vk-text-muted)]">
      <div className="w-[33%]" />
      <div className="flex w-[34%] items-center justify-center">
        <span className="truncate">{title}</span>
      </div>
      <div className="w-[33%]" />
    </header>
  );
}
