"use client";

import type { Terminal } from "xterm";

type WheelLikeEvent = {
  altKey: boolean;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  deltaMode: number;
  deltaX?: number;
  deltaY: number;
  shiftKey: boolean;
};

export function attachMobileTouchScrollShim(
  terminal: Terminal,
  host: HTMLElement,
): (() => void) | null {
  if (typeof window === "undefined") {
    return null;
  }

  const coarsePointer =
    typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
  const maxTouchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints || 0;
  if (!coarsePointer && maxTouchPoints <= 0) {
    return null;
  }

  const terminalRoot = host.querySelector<HTMLElement>(".xterm");
  const scrollHost = host.querySelector<HTMLElement>(".xterm-viewport")
    ?? host.querySelector<HTMLElement>(".xterm-scrollable-element");
  if (!terminalRoot || !scrollHost) {
    return null;
  }

  const setTouchAction = (active: boolean) => {
    const action = active ? "none" : "pan-y";
    host.style.setProperty("touch-action", action);
    terminalRoot.style.setProperty("touch-action", action);
    scrollHost.style.setProperty("touch-action", action);
    scrollHost.style.setProperty("-webkit-overflow-scrolling", "touch");
  };

  const resolveXtermCore = () => {
    const anyTerminal = terminal as any;
    return anyTerminal._core ?? anyTerminal.core ?? null;
  };

  const resolveCoreMouseService = () => {
    const core = resolveXtermCore();
    return core?.coreMouseService ?? core?._coreMouseService ?? null;
  };

  const resolveMouseTrackingMode = () => {
    const anyTerminal = terminal as any;
    const publicMode = anyTerminal.modes?.mouseTrackingMode;
    if (typeof publicMode === "string" && publicMode.length > 0) {
      return publicMode.toLowerCase();
    }

    const coreMouseService = resolveCoreMouseService();
    const activeProtocol = coreMouseService?.activeProtocol;
    if (typeof activeProtocol === "string" && activeProtocol.length > 0) {
      return activeProtocol.toLowerCase();
    }

    return coreMouseService?.areMouseEventsActive ? "unknown" : "none";
  };

  const isMouseProtocolActive = () => resolveMouseTrackingMode() !== "none";

  const dispatchCoreMouseWheel = (deltaY: number, clientX: number, clientY: number) => {
    const core = resolveXtermCore();
    const mouseService = core?._mouseService || core?.mouseService;
    const coreMouseService = resolveCoreMouseService();
    const viewport = core?.viewport;
    const screenElement = core?.screenElement || terminalRoot.querySelector(".xterm-screen");
    if (
      !mouseService
      || typeof mouseService.getMouseReportCoords !== "function"
      || !coreMouseService
      || typeof coreMouseService.triggerMouseEvent !== "function"
      || !coreMouseService.areMouseEventsActive
      || !viewport
      || typeof viewport.getLinesScrolled !== "function"
      || !screenElement
    ) {
      return false;
    }

    const wheelDeltaModePixel =
      typeof WheelEvent === "function" && typeof WheelEvent.DOM_DELTA_PIXEL === "number"
        ? WheelEvent.DOM_DELTA_PIXEL
        : 0;
    const wheelLikeEvent: WheelLikeEvent = {
      clientX,
      clientY,
      deltaY,
      deltaMode: wheelDeltaModePixel,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
    };
    const amount = viewport.getLinesScrolled(wheelLikeEvent);
    if (!amount) {
      return false;
    }

    const pos = mouseService.getMouseReportCoords(wheelLikeEvent, screenElement);
    if (!pos) {
      return false;
    }

    return coreMouseService.triggerMouseEvent({
      col: pos.col,
      row: pos.row,
      x: pos.x,
      y: pos.y,
      button: 4,
      action: deltaY < 0 ? 0 : 1,
      ctrl: false,
      alt: false,
      shift: false,
    });
  };

  const dispatchTerminalWheel = (
    deltaX: number,
    deltaY: number,
    clientX: number,
    clientY: number,
  ) => {
    if (typeof WheelEvent !== "function") {
      return false;
    }

    const eventTarget =
      document.elementFromPoint(clientX, clientY)
      ?? (terminal as any).element
      ?? terminalRoot;
    const beforeScrollTop = scrollHost.scrollTop;
    const wheelEvent = new WheelEvent("wheel", {
      deltaX,
      deltaY,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
    });

    const cancelled = !eventTarget.dispatchEvent(wheelEvent);
    return cancelled || wheelEvent.defaultPrevented || scrollHost.scrollTop !== beforeScrollTop;
  };

  let active = false;
  let lastX = 0;
  let lastY = 0;
  let touchStartAt = 0;
  let touchMoved = false;
  const LONG_PRESS_THRESHOLD_MS = 300;

  const reset = () => {
    active = false;
  };

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      setTouchAction(isMouseProtocolActive());
      reset();
      return;
    }

    const touch = event.touches[0];
    lastX = touch.clientX;
    lastY = touch.clientY;
    touchStartAt = window.performance?.now?.() ?? Date.now();
    touchMoved = false;
    setTouchAction(isMouseProtocolActive());
    active = true;
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (!active || event.touches.length !== 1) {
      return;
    }

    const touch = event.touches[0];
    const deltaX = lastX - touch.clientX;
    const deltaY = lastY - touch.clientY;
    lastX = touch.clientX;
    lastY = touch.clientY;

    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
      return;
    }

    touchMoved = true;
    // Let xterm handle native touch scrolling unless mouse reporting is active.
    if (!isMouseProtocolActive()) {
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }

    if (!dispatchCoreMouseWheel(deltaY, touch.clientX, touch.clientY)) {
      if (!dispatchTerminalWheel(deltaX, deltaY, touch.clientX, touch.clientY)) {
        const maxScrollTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
        scrollHost.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollHost.scrollTop + deltaY));
      }
    }
  };

  const handleTouchEnd = () => {
    const touchDuration = (window.performance?.now?.() ?? Date.now()) - touchStartAt;
    if (!touchMoved && touchDuration < LONG_PRESS_THRESHOLD_MS) {
      terminal.focus();
    }
    setTouchAction(isMouseProtocolActive());
    reset();
  };

  terminalRoot.addEventListener("touchstart", handleTouchStart, { passive: true });
  terminalRoot.addEventListener("touchmove", handleTouchMove, { passive: false });
  terminalRoot.addEventListener("touchend", handleTouchEnd, { passive: true });
  terminalRoot.addEventListener("touchcancel", handleTouchEnd, { passive: true });
  setTouchAction(isMouseProtocolActive());

  return () => {
    terminalRoot.removeEventListener("touchstart", handleTouchStart);
    terminalRoot.removeEventListener("touchmove", handleTouchMove);
    terminalRoot.removeEventListener("touchend", handleTouchEnd);
    terminalRoot.removeEventListener("touchcancel", handleTouchEnd);
    host.style.removeProperty("touch-action");
    terminalRoot.style.removeProperty("touch-action");
    scrollHost.style.removeProperty("touch-action");
    scrollHost.style.removeProperty("-webkit-overflow-scrolling");
  };
}
