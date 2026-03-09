"use client";

import { useCallback, useState } from "react";

const DESKTOP_BREAKPOINT_PX = 1024;

function isDesktopViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth >= DESKTOP_BREAKPOINT_PX;
}

export function useResponsiveSidebarState() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);

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
    closeSidebarOnMobile,
    syncSidebarForViewport,
  };
}
