import type { MutableRefObject } from "react";

type DialogAutoFocusEvent = {
  preventDefault: () => void;
};

type FocusableTarget = Pick<HTMLElement, "focus" | "isConnected"> & {
  disabled?: boolean;
};

function isFocusableTarget(value: unknown): value is FocusableTarget {
  return !!value && typeof value === "object" && typeof (value as { focus?: unknown }).focus === "function";
}

export function captureDialogAutoFocusTarget(activeElement: Element | null): HTMLElement | null {
  return isFocusableTarget(activeElement) ? (activeElement as HTMLElement) : null;
}

export function restoreDialogAutoFocusTarget(
  opener: HTMLElement | null,
  event: DialogAutoFocusEvent,
): boolean {
  if (!isFocusableTarget(opener) || opener.isConnected === false || opener.disabled === true) {
    return false;
  }
  event.preventDefault();
  opener.focus({ preventScroll: true });
  return true;
}

export function captureDialogOpener(openerRef: MutableRefObject<HTMLElement | null>): void {
  if (typeof document === "undefined") return;
  openerRef.current = captureDialogAutoFocusTarget(document.activeElement);
}

export function restoreDialogOpener(
  openerRef: MutableRefObject<HTMLElement | null>,
  event: DialogAutoFocusEvent,
): boolean {
  const opener = openerRef.current;
  openerRef.current = null;
  return restoreDialogAutoFocusTarget(opener, event);
}

export function findVisibleWorkspacePanelOpener(): HTMLButtonElement | null {
  if (typeof document === "undefined") return null;

  for (const opener of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Open workspace panel"]')) {
    if (!isFocusableTarget(opener) || opener.isConnected === false || opener.disabled === true) {
      continue;
    }
    if (typeof opener.getClientRects === "function" && opener.getClientRects().length === 0) {
      continue;
    }
    return opener;
  }

  return null;
}

export function focusVisibleWorkspacePanelOpenerIfNeeded(activeElement?: Element | null): boolean {
  if (typeof document === "undefined") return false;

  const currentActiveElement = activeElement === undefined ? document.activeElement : activeElement;
  if (currentActiveElement && currentActiveElement !== document.body) {
    return false;
  }

  const opener = findVisibleWorkspacePanelOpener();
  if (!opener) {
    return false;
  }

  opener.focus({ preventScroll: true });
  return true;
}
