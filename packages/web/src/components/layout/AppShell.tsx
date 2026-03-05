"use client";

import type { CSSProperties, ReactNode } from "react";
import { PanelLeftOpen, PanelRightClose } from "lucide-react";
import { cn } from "@/lib/cn";

interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function AppShell({
  sidebar,
  children,
  sidebarOpen,
  onToggleSidebar,
}: AppShellProps) {
  const shellStyle = { "--workspace-sidebar-width": "356px" } as CSSProperties;

  return (
    <div
      style={shellStyle}
      className="relative flex h-dvh min-h-[100dvh] w-full max-w-full overflow-hidden bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)]"
    >
      {sidebarOpen && (
        <button
          type="button"
          className="absolute inset-0 z-20 bg-black/45 lg:hidden"
          onClick={onToggleSidebar}
          aria-label="Close workspace panel"
        />
      )}

      <aside
        className={cn(
          "absolute inset-y-0 left-0 z-30 flex h-full w-[min(90vw,var(--workspace-sidebar-width))] flex-col border-r border-[var(--vk-border)] bg-[var(--vk-bg-panel)] transition-transform duration-200 lg:relative lg:w-[var(--workspace-sidebar-width)]",
          sidebarOpen
            ? "translate-x-0"
            : "-translate-x-full lg:-translate-x-0 lg:w-0 lg:overflow-hidden lg:border-r-0",
          "lg:left-auto",
        )}
      >
        {sidebar}
      </aside>

      {sidebarOpen && (
        <button
          type="button"
          onClick={onToggleSidebar}
          className="absolute left-[var(--workspace-sidebar-width)] top-2 z-40 hidden h-7 w-7 -translate-x-1/2 items-center justify-center rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-muted)] shadow-[0_0_0_1px_rgba(0,0,0,0.25)] hover:bg-[var(--vk-bg-hover)] lg:inline-flex"
          aria-label="Hide workspace panel"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      )}

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--vk-bg-main)]">
        {!sidebarOpen && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="absolute left-2 top-2 z-40 inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
            aria-label="Open workspace panel"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
        {children}
      </main>
    </div>
  );
}
