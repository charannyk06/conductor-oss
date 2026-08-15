"use client";

import { useEffect, type ReactNode } from "react";
import {
  APP_SHELL_DOCUMENT_CLASS_NAME,
  KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VAR,
  KEYBOARD_SAFE_VISUAL_VIEWPORT_HEIGHT_CSS_VAR,
  KEYBOARD_SAFE_VISUAL_VIEWPORT_OFFSET_TOP_CSS_VAR,
  resolveKeyboardSafeViewportMetrics,
  resolveStableLayoutViewportHeight,
  shouldResetStableLayoutViewportHeight,
} from "@/components/layout/keyboardSafeViewport";

type KeyboardSafeViewportMetricsProviderProps = {
  children: ReactNode;
  lockDocumentScrolling?: boolean;
};

export function KeyboardSafeViewportMetricsProvider({
  children,
  lockDocumentScrolling = false,
}: KeyboardSafeViewportMetricsProviderProps) {
  useEffect(() => {
    const root = document.documentElement;
    const initialVisualViewport = window.visualViewport;
    const getLayoutViewportWidth = () => Math.max(0, window.innerWidth, root.clientWidth);
    let stableLayoutViewportWidth = getLayoutViewportWidth();
    let stableLayoutViewportHeight = resolveStableLayoutViewportHeight(
      0,
      window.innerHeight,
      root.clientHeight,
      initialVisualViewport?.height ?? Number.NaN,
      initialVisualViewport?.offsetTop ?? Number.NaN,
    );

    const syncViewportMetrics = () => {
      const visualViewport = window.visualViewport;
      const layoutViewportWidth = getLayoutViewportWidth();
      if (shouldResetStableLayoutViewportHeight(stableLayoutViewportWidth, layoutViewportWidth)) {
        stableLayoutViewportHeight = 0;
      }
      stableLayoutViewportWidth = layoutViewportWidth;
      stableLayoutViewportHeight = resolveStableLayoutViewportHeight(
        stableLayoutViewportHeight,
        window.innerHeight,
        root.clientHeight,
        visualViewport?.height ?? Number.NaN,
        visualViewport?.offsetTop ?? Number.NaN,
      );
      const viewportMetrics = resolveKeyboardSafeViewportMetrics(
        stableLayoutViewportHeight,
        visualViewport?.height ?? Number.NaN,
        visualViewport?.offsetTop ?? Number.NaN,
      );
      root.style.setProperty(KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VAR, `${viewportMetrics.bottom}px`);
      root.style.setProperty(
        KEYBOARD_SAFE_VISUAL_VIEWPORT_HEIGHT_CSS_VAR,
        `${viewportMetrics.visibleHeight}px`,
      );
      root.style.setProperty(
        KEYBOARD_SAFE_VISUAL_VIEWPORT_OFFSET_TOP_CSS_VAR,
        `${viewportMetrics.offsetTop}px`,
      );
    };

    if (lockDocumentScrolling) {
      root.classList.add(APP_SHELL_DOCUMENT_CLASS_NAME);
    }
    syncViewportMetrics();
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", syncViewportMetrics);
    visualViewport?.addEventListener("scroll", syncViewportMetrics);
    window.addEventListener("resize", syncViewportMetrics);

    return () => {
      visualViewport?.removeEventListener("resize", syncViewportMetrics);
      visualViewport?.removeEventListener("scroll", syncViewportMetrics);
      window.removeEventListener("resize", syncViewportMetrics);
      if (lockDocumentScrolling) {
        root.classList.remove(APP_SHELL_DOCUMENT_CLASS_NAME);
      }
      root.style.removeProperty(KEYBOARD_SAFE_VIEWPORT_HEIGHT_CSS_VAR);
      root.style.removeProperty(KEYBOARD_SAFE_VISUAL_VIEWPORT_HEIGHT_CSS_VAR);
      root.style.removeProperty(KEYBOARD_SAFE_VISUAL_VIEWPORT_OFFSET_TOP_CSS_VAR);
    };
  }, [lockDocumentScrolling]);

  return children;
}
