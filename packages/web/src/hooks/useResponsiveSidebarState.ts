"use client";

import { useCallback, useState } from "react";

const DESKTOP_BREAKPOINT_PX = 1024;

function isDesktopViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth >= DESKTOP_BREAKPOINT_PX;
}

export function useResponsiveSidebarState() {
  return useResponsiveSidebarStateWithOptions();
}

interface ResponsiveSidebarOptions {
  initialDesktopOpen?: boolean;
}

export function useResponsiveSidebarStateWithOptions(options?: ResponsiveSidebarOptions) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(options?.initialDesktopOpen ?? true);

  const toggleSidebar = useCallback(() => {
    if (isDesktopViewport()) {
      setDesktopSidebarOpen((current) => !current);
      return;
    }

    setMobileSidebarOpen((current) => !current);
  }, []);

  const closeSidebarOnMobile = useCallback(() => {
    if (!isDesktopViewport()) {
      setMobileSidebarOpen(false);
    }
  }, []);

  const closeSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
    setDesktopSidebarOpen(false);
  }, []);

  const syncSidebarForViewport = useCallback(() => {
    if (isDesktopViewport()) {
      setDesktopSidebarOpen(true);
      return;
    }

    setMobileSidebarOpen(false);
  }, []);

  return {
    mobileSidebarOpen,
    desktopSidebarOpen,
    toggleSidebar,
    closeSidebar,
    closeSidebarOnMobile,
    syncSidebarForViewport,
  };
}
