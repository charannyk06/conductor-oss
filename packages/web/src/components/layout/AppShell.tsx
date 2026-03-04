"use client";

import type { ReactNode } from "react";
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
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0d1117]">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col border-r border-[var(--color-border-default)] bg-[var(--color-bg-surface)] transition-[width] duration-200",
          sidebarOpen ? "w-[280px]" : "w-0 overflow-hidden border-r-0",
        )}
      >
        {sidebar}
      </aside>

      {/* Main content area */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Sidebar toggle when collapsed */}
        {!sidebarOpen && (
          <button
            onClick={onToggleSidebar}
            className="absolute left-2 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)]"
            aria-label="Open sidebar"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M3 4h10M3 8h10M3 12h10" />
            </svg>
          </button>
        )}
        {children}
      </main>
    </div>
  );
}
