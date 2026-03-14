"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeftOpen, PanelRightClose } from "lucide-react";
import { cn } from "@/lib/cn";
import { AppUpdateNotice } from "@/components/layout/AppUpdateNotice";

interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  mobileSidebarOpen: boolean;
  desktopSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

const DEFAULT_SIDEBAR_WIDTH = 356;
const MIN_SIDEBAR_WIDTH = 296;
const MAX_SIDEBAR_WIDTH = 460;
const SIDEBAR_WIDTH_STORAGE_KEY = "conductor-workspace-sidebar-width";

export function AppShell({
  sidebar,
  children,
  mobileSidebarOpen,
  desktopSidebarOpen,
  onToggleSidebar,
}: AppShellProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
      const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
      if (Number.isFinite(parsed)) {
        setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed)));
      }
    } catch {
      // Ignore invalid persisted width values.
    }
  }, []);

  useEffect(() => {
    if (!resizing) return;

    const handlePointerMove = (event: MouseEvent) => {
      const nextWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, event.clientX));
      setSidebarWidth(nextWidth);
    };

    const handlePointerUp = () => {
      setResizing(false);
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
      } catch {
        // Ignore storage write failures.
      }
    };
  }, [resizing, sidebarWidth]);

  const shellStyle = { "--workspace-sidebar-width": `${sidebarWidth}px` } as CSSProperties;

  return (
    <div
      style={shellStyle}
      className="relative flex h-dvh min-h-[100dvh] w-full max-w-full overflow-hidden bg-[var(--vk-bg-main)] text-[var(--vk-text-normal)] [padding-top:env(safe-area-inset-top)] [padding-bottom:env(safe-area-inset-bottom)]"
    >
      {mobileSidebarOpen && (
        <button
          type="button"
          className="absolute inset-0 z-20 bg-black/45 lg:hidden"
          onClick={onToggleSidebar}
          aria-label="Close workspace panel"
        />
      )}

      <aside
        className={cn(
          "absolute inset-y-0 left-0 z-30 flex h-full w-full max-w-none flex-col border-r border-[var(--vk-border)] bg-[var(--vk-bg-panel)] transition-[transform,width] duration-200 sm:w-[min(90vw,var(--workspace-sidebar-width))] sm:max-w-[28rem]",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
          desktopSidebarOpen
            ? "lg:w-[var(--workspace-sidebar-width)]"
            : "lg:w-0 lg:overflow-hidden lg:border-r-0",
          "lg:relative lg:left-auto lg:translate-x-0",
        )}
      >
        {sidebar}
      </aside>

      {desktopSidebarOpen ? (
        <div
          className="absolute bottom-0 left-[var(--workspace-sidebar-width)] top-0 z-30 hidden w-2 -translate-x-1/2 cursor-col-resize lg:block"
          onMouseDown={() => setResizing(true)}
          aria-hidden="true"
        >
          <div className="mx-auto h-full w-px bg-transparent transition-colors hover:bg-[var(--vk-border)]" />
        </div>
      ) : null}

      {desktopSidebarOpen && (
        <button
          type="button"
          onClick={onToggleSidebar}
          className="absolute left-[var(--workspace-sidebar-width)] top-2 z-40 hidden h-7 w-7 -translate-x-1/2 items-center justify-center rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-muted)] shadow-[0_0_0_1px_rgba(0,0,0,0.25)] hover:bg-[var(--vk-bg-hover)] lg:inline-flex"
          aria-label="Hide workspace panel"
        >
          <PanelRightClose className="h-5 w-5" />
        </button>
      )}

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--vk-bg-main)]">
        {!mobileSidebarOpen && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="absolute left-2 top-2 z-40 inline-flex h-11 w-11 items-center justify-center rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-muted)] shadow-[0_10px_24px_rgba(0,0,0,0.28)] hover:bg-[var(--vk-bg-hover)] sm:h-8 sm:w-8 lg:hidden"
            aria-label="Open workspace panel"
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
        )}
        {!desktopSidebarOpen && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="absolute left-2 top-2 z-40 hidden h-7 w-7 items-center justify-center rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] lg:inline-flex"
            aria-label="Open workspace panel"
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
        )}
        {children}
      </main>

      <AppUpdateNotice />
    </div>
  );
}
