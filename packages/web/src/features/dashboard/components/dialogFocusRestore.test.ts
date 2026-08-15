import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  captureDialogAutoFocusTarget,
  focusVisibleWorkspacePanelOpenerIfNeeded,
  findVisibleWorkspacePanelOpener,
  restoreDialogAutoFocusTarget,
} from "./dialogFocusRestore";

test("captureDialogAutoFocusTarget stores the active opener when it can be focused", () => {
  const opener = {
    focus() {},
    isConnected: true,
  } as unknown as HTMLElement;

  assert.equal(captureDialogAutoFocusTarget(opener), opener);
  assert.equal(captureDialogAutoFocusTarget(null), null);
  assert.equal(captureDialogAutoFocusTarget({} as Element), null);
});

test("restoreDialogAutoFocusTarget prevents default Radix restoration and focuses the stored opener", () => {
  const calls: FocusOptions[] = [];
  const opener = {
    focus(options?: FocusOptions) {
      calls.push(options ?? {});
    },
    isConnected: true,
  } as unknown as HTMLElement;
  let prevented = false;

  const restored = restoreDialogAutoFocusTarget(opener, {
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(restored, true);
  assert.equal(prevented, true);
  assert.deepEqual(calls, [{ preventScroll: true }]);
});

test("restoreDialogAutoFocusTarget skips stale or disabled openers", () => {
  for (const opener of [
    {
      focus() {
        throw new Error("should not focus disconnected opener");
      },
      isConnected: false,
    } as unknown as HTMLElement,
    {
      focus() {
        throw new Error("should not focus disabled opener");
      },
      isConnected: true,
      disabled: true,
    } as unknown as HTMLElement,
  ]) {
    let prevented = false;
    const restored = restoreDialogAutoFocusTarget(opener, {
      preventDefault() {
        prevented = true;
      },
    });

    assert.equal(restored, false);
    assert.equal(prevented, false);
  }
});

test("findVisibleWorkspacePanelOpener skips hidden or stale matches and returns the visible enabled button", () => {
  const visibleOpener = {
    focus() {},
    isConnected: true,
    getClientRects() {
      return { length: 1 } as DOMRectList;
    },
  } as unknown as HTMLButtonElement;
  const originalDocument = globalThis.document;
  const matches = [
    {
      focus() {
        throw new Error("should not focus disconnected opener");
      },
      isConnected: false,
      getClientRects() {
        return { length: 1 } as DOMRectList;
      },
    },
    {
      focus() {
        throw new Error("should not focus hidden opener");
      },
      isConnected: true,
      getClientRects() {
        return { length: 0 } as DOMRectList;
      },
    },
    {
      focus() {
        throw new Error("should not focus disabled opener");
      },
      isConnected: true,
      disabled: true,
      getClientRects() {
        return { length: 1 } as DOMRectList;
      },
    },
    visibleOpener,
  ] as unknown as NodeListOf<HTMLButtonElement>;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll() {
        return matches;
      },
    } as Pick<Document, "querySelectorAll">,
  });

  try {
    assert.equal(findVisibleWorkspacePanelOpener(), visibleOpener);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});

test("focusVisibleWorkspacePanelOpenerIfNeeded repairs missing focus by targeting the visible workspace opener", () => {
  const focusCalls: FocusOptions[] = [];
  const visibleOpener = {
    focus(options?: FocusOptions) {
      focusCalls.push(options ?? {});
    },
    isConnected: true,
    getClientRects() {
      return { length: 1 } as DOMRectList;
    },
  } as unknown as HTMLButtonElement;
  const body = { nodeName: "BODY" } as unknown as HTMLBodyElement;
  const originalDocument = globalThis.document;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: body,
      body,
      querySelectorAll() {
        return [visibleOpener] as unknown as NodeListOf<HTMLButtonElement>;
      },
    } as Pick<Document, "activeElement" | "body" | "querySelectorAll">,
  });

  try {
    assert.equal(focusVisibleWorkspacePanelOpenerIfNeeded(), true);
    assert.equal(focusVisibleWorkspacePanelOpenerIfNeeded(null), true);
    assert.deepEqual(focusCalls, [{ preventScroll: true }, { preventScroll: true }]);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});

test("focusVisibleWorkspacePanelOpenerIfNeeded leaves valid restored focus alone", () => {
  let queryCount = 0;
  const activeTrigger = {
    focus() {
      throw new Error("should not override a valid trigger focus target");
    },
    isConnected: true,
  } as unknown as HTMLButtonElement;
  const body = { nodeName: "BODY" } as unknown as HTMLBodyElement;
  const originalDocument = globalThis.document;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: activeTrigger,
      body,
      querySelectorAll() {
        queryCount += 1;
        return [] as unknown as NodeListOf<HTMLButtonElement>;
      },
    } as Pick<Document, "activeElement" | "body" | "querySelectorAll">,
  });

  try {
    assert.equal(focusVisibleWorkspacePanelOpenerIfNeeded(), false);
    assert.equal(queryCount, 0);
  } finally {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});

test("controlled dashboard dialogs capture and restore the active opener through Radix autofocus hooks", () => {
  const source = readFileSync(new URL("./DashboardDialogs.tsx", import.meta.url), "utf8");

  assert.equal(source.match(/captureDialogOpener\(openerRef\);/g)?.length, 3);
  assert.equal(source.match(/restoreDialogOpener\(openerRef, event\)/g)?.length, 3);
  assert.match(source, /<Dialog\.Content[\s\S]*onOpenAutoFocus=\{\(\) => \{\s*captureDialogOpener\(openerRef\);/);
  assert.match(source, /<Dialog\.Content[\s\S]*onCloseAutoFocus=\{\(event\) => \{\s*if \(restoreDialogOpener\(openerRef, event\)\) return;\s*const workspacePanelOpener = findVisibleWorkspacePanelOpener\(\);\s*if \(!workspacePanelOpener\) return;\s*event\.preventDefault\(\);\s*workspacePanelOpener\.focus\(\{ preventScroll: true \}\);/);
  assert.equal(source.match(/findVisibleWorkspacePanelOpener\(\);/g)?.length, 1);
});

test("new workspace dialog and nested folder picker stay mounted so Radix close autofocus can restore focus", () => {
  const dashboardClientSource = readFileSync(
    new URL("../DashboardClient.tsx", import.meta.url),
    "utf8",
  );
  const dashboardDialogsSource = readFileSync(
    new URL("./DashboardDialogs.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    dashboardClientSource,
    /<NewWorkspaceDialog\s+open=\{newWorkspaceOpen\}\s+onClose=\{handleCloseNewWorkspaceDialog\}/,
  );
  assert.doesNotMatch(
    dashboardClientSource,
    /\{newWorkspaceOpen \? \(\s*<NewWorkspaceDialog/,
  );
  const newWorkspaceDialogBlock = dashboardDialogsSource.match(
    /export function NewWorkspaceDialog[\s\S]*?\n}\n\nfunction FolderPickerDialog/,
  );

  assert.ok(newWorkspaceDialogBlock, "expected to isolate the NewWorkspaceDialog source block");
  assert.doesNotMatch(
    newWorkspaceDialogBlock[0],
    /if \(!open\) return null;/,
  );
  assert.match(
    newWorkspaceDialogBlock[0],
    /<Dialog\.Root open=\{open\} onOpenChange=\{handleDialogOpenChange\}>/,
  );
  const folderPickerDialogBlock = dashboardDialogsSource.match(
    /function FolderPickerDialog\([\s\S]*?\n}\n\nexport function SettingsDialog/,
  );

  assert.ok(folderPickerDialogBlock, "expected to isolate the FolderPickerDialog source block");
  assert.doesNotMatch(
    folderPickerDialogBlock[0],
    /if \(!open\) return null;/,
  );
  assert.match(
    folderPickerDialogBlock[0],
    /<Dialog\.Root\s+open=\{open\}\s+onOpenChange=\{\(nextOpen\) => \{/,
  );
});

test("settings dialog stays mounted in dashboard client so Radix close autofocus can run", () => {
  const dashboardClientSource = readFileSync(
    new URL("../DashboardClient.tsx", import.meta.url),
    "utf8",
  );
  const dashboardDialogsSource = readFileSync(
    new URL("./DashboardDialogs.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    dashboardClientSource,
    /<SettingsDialog\s+open=\{preferencesDialogOpen\}\s+mode=\{onboardingRequired \? "onboarding" : "settings"\}/,
  );
  assert.doesNotMatch(
    dashboardClientSource,
    /\{preferencesDialogOpen \|\| onboardingRequired \? \(\s*<SettingsDialog/,
  );
  const settingsDialogBlock = dashboardDialogsSource.match(
    /export function SettingsDialog[\s\S]*$/,
  );

  assert.ok(settingsDialogBlock, "expected to isolate the SettingsDialog source block");
  assert.doesNotMatch(
    settingsDialogBlock[0],
    /if \(!open\) return null;/,
  );
  assert.match(
    settingsDialogBlock[0],
    /<Dialog\.Root open=\{open\} onOpenChange=\{handleDialogOpenChange\}>/,
  );
});

test("dashboard client repairs mobile body focus after the new workspace dialog closes", () => {
  const source = readFileSync(
    new URL("../DashboardClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /const previousNewWorkspaceOpenRef = useRef\(newWorkspaceOpen\);/);
  assert.match(source, /const wasNewWorkspaceOpen = previousNewWorkspaceOpenRef\.current;/);
  assert.match(source, /previousNewWorkspaceOpenRef\.current = newWorkspaceOpen;/);
  assert.match(source, /if \(!wasNewWorkspaceOpen \|\| newWorkspaceOpen \|\| typeof window === "undefined"\) \{/);
  assert.match(source, /window\.requestAnimationFrame\(\(\) => \{\s*focusVisibleWorkspacePanelOpenerIfNeeded\(\);\s*}\)/);
});
