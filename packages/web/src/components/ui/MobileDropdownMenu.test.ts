import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MOBILE_DROPDOWN_COLLISION_PADDING,
  MOBILE_DROPDOWN_CONTENT_CLASS_NAME,
  MOBILE_DROPDOWN_LAYER_CLASS_NAME,
  MOBILE_DROPDOWN_MAX_HEIGHT,
  MOBILE_DROPDOWN_MAX_WIDTH,
} from "./MobileDropdownMenu";

test("mobile dropdown surfaces stay above dialogs and inside the visual viewport", () => {
  assert.equal(MOBILE_DROPDOWN_LAYER_CLASS_NAME, "z-[160]");
  assert.ok(MOBILE_DROPDOWN_COLLISION_PADDING >= 12);
  assert.match(MOBILE_DROPDOWN_CONTENT_CLASS_NAME, /overflow-y-auto/);
  assert.match(MOBILE_DROPDOWN_CONTENT_CLASS_NAME, /overscroll-contain/);
  assert.match(MOBILE_DROPDOWN_CONTENT_CLASS_NAME, /touch-pan-y/);
  assert.match(MOBILE_DROPDOWN_MAX_HEIGHT, /--radix-dropdown-menu-content-available-height/);
  assert.match(MOBILE_DROPDOWN_MAX_HEIGHT, /--oc-visual-viewport-height/);
  assert.match(MOBILE_DROPDOWN_MAX_HEIGHT, /safe-area-inset-top/);
  assert.match(MOBILE_DROPDOWN_MAX_HEIGHT, /safe-area-inset-bottom/);
  assert.match(MOBILE_DROPDOWN_MAX_WIDTH, /--radix-dropdown-menu-content-available-width/);
  assert.match(MOBILE_DROPDOWN_MAX_WIDTH, /safe-area-inset-left/);
  assert.match(MOBILE_DROPDOWN_MAX_WIDTH, /safe-area-inset-right/);
});

test("mobile coarse pointers receive full-size menu and native select targets", () => {
  const source = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

  assert.match(
    source,
    /@media \(max-width: 767px\), \(pointer: coarse\) \{[\s\S]*?input:not\([\s\S]*?textarea,[\s\S]*?select \{[^}]*font-size:\s*16px !important/s,
  );
  assert.match(source, /button\[aria-haspopup="menu"\]/);
  assert.match(source, /\.oc-mobile-menu-content \[role="menuitem"\]/);
  assert.match(source, /min-height:\s*44px/);
  assert.match(source, /select\s*\{[^}]*min-height:\s*44px/s);
});

test("coarse-pointer overflow containment stays on each scroller's owned axis", () => {
  const source = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

  assert.match(source, /\.overflow-x-auto\s*\{[^}]*overscroll-behavior-x:\s*contain/s);
  assert.match(source, /\.overflow-y-auto\s*\{[^}]*overscroll-behavior-y:\s*contain/s);
  assert.match(source, /\.overflow-auto\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.doesNotMatch(source, /\.overflow-x-auto\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.doesNotMatch(source, /\.overflow-y-auto\s*\{[^}]*overscroll-behavior:\s*contain/s);
});

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

test("every application dropdown uses the shared portaled mobile content contract", () => {
  const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
  const directRadixContentUsers = collectSourceFiles(sourceRoot).filter((path) => {
    if (path.endsWith("MobileDropdownMenu.tsx")) return false;
    const source = readFileSync(path, "utf8");
    return /<DropdownMenu\.(?:Portal|Content)\b/.test(source);
  });

  assert.deepEqual(directRadixContentUsers, []);
});

test("critical mobile dialogs and launch toggles use visual viewport and touch contracts", () => {
  const dispatcherDialogSource = readFileSync(
    new URL("../dispatcher/ProjectDispatcherPanel.tsx", import.meta.url),
    "utf8",
  );
  const quickSwitcherSource = readFileSync(
    new URL("../notes/QuickSwitcher.tsx", import.meta.url),
    "utf8",
  );
  const dashboardSource = readFileSync(
    new URL("../../features/dashboard/DashboardClient.tsx", import.meta.url),
    "utf8",
  );
  const dashboardDialogsSource = readFileSync(
    new URL("../../features/dashboard/components/DashboardDialogs.tsx", import.meta.url),
    "utf8",
  );

  assert.match(dispatcherDialogSource, /KEYBOARD_SAFE_VIEWPORT_OVERLAY_CLASS_NAME/);
  assert.match(dispatcherDialogSource, /KEYBOARD_SAFE_VIEWPORT_INSET_FRAME_CLASS_NAME/);
  assert.match(dispatcherDialogSource, /overflow-y-auto overscroll-contain/);
  assert.match(quickSwitcherSource, /KEYBOARD_SAFE_VIEWPORT_OVERLAY_CLASS_NAME/);
  assert.match(quickSwitcherSource, /KEYBOARD_SAFE_VIEWPORT_INSET_FRAME_CLASS_NAME/);
  assert.doesNotMatch(quickSwitcherSource, /top-\[20%\]/);
  assert.doesNotMatch(dashboardSource, /avoidCollisions=\{false\}/);
  assert.ok((dashboardSource.match(/oc-mobile-touch-target/g) ?? []).length >= 8);
  assert.match(dashboardSource, /min-h-11 w-full resize-none bg-transparent pr-24/);
  assert.match(dashboardSource, /oc-mobile-touch-target absolute right-11[^\n]*h-11 w-11/);
  assert.match(dashboardSource, /oc-mobile-touch-target absolute right-0[^\n]*h-11 w-11/);
  assert.match(
    dashboardDialogsSource,
    /z-\[90\][^`]*overflow-hidden[^`]*px-0 py-0[^`]*sm:overflow-y-auto/,
  );
  assert.doesNotMatch(
    dashboardDialogsSource,
    /z-\[90\][^`]*overflow-y-auto bg-black\/70 px-3 py-3/,
  );
});
