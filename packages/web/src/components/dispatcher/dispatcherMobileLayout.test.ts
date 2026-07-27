import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DISPATCHER_CHAT_FEED_SCROLL_CLASS_NAME,
  DISPATCHER_CHAT_FRAME_CLASS_NAME,
  DISPATCHER_DESKTOP_XL_MEDIA_QUERY,
  DISPATCHER_SURFACE_CONTENT_CLASS_NAME,
  DISPATCHER_SURFACE_OVERLAY_CLASS_NAME,
  watchDispatcherDesktopXl,
} from "./dispatcherMobileLayout";

test("dispatcher chat frame uses the shared visual viewport contract", () => {
  assert.match(DISPATCHER_CHAT_FRAME_CLASS_NAME, /oc-safe-viewport-height/);
  assert.match(DISPATCHER_CHAT_FRAME_CLASS_NAME, /sm:h-full/);
});

test("dispatcher feed scroll helper keeps the feed as the mobile scroll owner", () => {
  assert.match(DISPATCHER_CHAT_FEED_SCROLL_CLASS_NAME, /overflow-y-auto/);
  assert.match(DISPATCHER_CHAT_FEED_SCROLL_CLASS_NAME, /touch-pan-y/);
  assert.match(DISPATCHER_CHAT_FEED_SCROLL_CLASS_NAME, /-webkit-overflow-scrolling:touch/);
});

test("dispatcher surfaces reuse the app sheet and dialog keyboard-safe helpers", () => {
  assert.match(DISPATCHER_SURFACE_OVERLAY_CLASS_NAME, /fixed inset-0/);
  assert.match(DISPATCHER_SURFACE_CONTENT_CLASS_NAME, /oc-visual-viewport-height/);
  assert.match(DISPATCHER_SURFACE_CONTENT_CLASS_NAME, /sm:max-h-\[calc\(var\(--oc-visual-viewport-height,100dvh\)-3rem\)\]/);
});

test("dispatcher session pane uses the shared mobile feed and surface classes", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");
  const layoutSource = readFileSync(new URL("./dispatcherMobileLayout.ts", import.meta.url), "utf8");

  assert.match(source, /DISPATCHER_CHAT_FRAME_CLASS_NAME/);
  assert.match(source, /DISPATCHER_CHAT_FEED_SCROLL_CLASS_NAME/);
  assert.match(source, /DISPATCHER_SURFACE_CONTENT_CLASS_NAME/);
  assert.match(source, /DISPATCHER_SURFACE_OVERLAY_CLASS_NAME/);
  assert.match(layoutSource, /KEYBOARD_SAFE_VIEWPORT_MAX_BOTTOM_CLASS_NAME/);
});

test("dispatcher session header offsets the mobile workspace toggle and resets to desktop spacing", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /className="flex h-\[33px\] items-center gap-2 border-b border-\[var\(--vk-border\)\] pl-14 pr-3 text-\[12px\] text-\[var\(--vk-text-muted\)\] sm:px-3"/);
  assert.match(source, /<span className="min-w-0 flex-1 truncate">\{sessionLabel\}<\/span>/);
});

test("project dispatcher panel delegates mobile back controls into the chat header", () => {
  const source = readFileSync(new URL("./ProjectDispatcherPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /const mobileBackButton = onBackToBoard \?/);
  assert.match(source, /if \(loadingThreads && !dispatcherSession\)[\s\S]*\{mobileBackButton\}/);
  assert.match(source, /if \(!dispatcherSession\)[\s\S]*\{mobileBackButton\}/);
  assert.match(source, /onBackToBoard=\{onBackToBoard\}/);
  assert.doesNotMatch(source, /DISPATCHER_CHAT_FRAME_CLASS_NAME/);
});

test("dispatcher settings sheet exposes an explicit Done control", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /<Dialog\.Close asChild>/);
  assert.match(source, />\s*Done\s*</);
});

test("dispatcher desktop xl watcher closes immediately on entry, listens for breakpoint changes, and cleans up", () => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = true;
  const mediaQuery = {
    get matches() {
      return matches;
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      assert.equal(type, "change");
      assert.equal(typeof listener, "function");
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      assert.equal(type, "change");
      assert.equal(typeof listener, "function");
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
  } as unknown as MediaQueryList;
  const seenQueries: string[] = [];
  let closeCount = 0;

  const cleanup = watchDispatcherDesktopXl(() => {
    closeCount += 1;
  }, (query) => {
    seenQueries.push(query);
    return mediaQuery;
  });

  assert.deepEqual(seenQueries, [DISPATCHER_DESKTOP_XL_MEDIA_QUERY]);
  assert.equal(closeCount, 1);
  assert.equal(listeners.size, 1);

  matches = false;
  for (const listener of listeners) {
    listener({ matches: false } as MediaQueryListEvent);
  }
  assert.equal(closeCount, 1);

  matches = true;
  for (const listener of listeners) {
    listener({ matches: true } as MediaQueryListEvent);
  }
  assert.equal(closeCount, 2);

  cleanup();
  assert.equal(listeners.size, 0);
});

test("dispatcher composer restores desktop inline controls and keeps the settings chip mobile-only", () => {
  const sessionPaneSource = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");
  const paneSource = readFileSync(new URL("./DispatcherPane.tsx", import.meta.url), "utf8");

  assert.match(sessionPaneSource, /composerToolbar\?: ReactNode;/);
  assert.match(sessionPaneSource, /className="mb-2\.5 hidden xl:block"/);
  assert.match(sessionPaneSource, /className="mt-2 flex min-w-0 items-center gap-2 xl:hidden"/);
  assert.match(paneSource, /const composerToolbar = showPreferenceEditor \?/);
  assert.match(paneSource, /composerToolbar=\{composerToolbar\}/);
});

test("dispatcher session pane closes the mobile settings sheet once the xl breakpoint matches", () => {
  const source = readFileSync(new URL("./DispatcherSessionPane.tsx", import.meta.url), "utf8");

  assert.match(source, /if \(!settingsOpen\) \{\s*return undefined;\s*\}/);
  assert.match(source, /return watchDispatcherDesktopXl\(\(\) => \{\s*setSettingsOpen\(false\);\s*\}\);/);
  assert.match(source, /window\.matchMedia\(DISPATCHER_DESKTOP_XL_MEDIA_QUERY\)\.matches/);
});

test("dashboard client reuses the shared dispatcher xl media query", () => {
  const source = readFileSync(new URL("../../features/dashboard/DashboardClient.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ DISPATCHER_DESKTOP_XL_MEDIA_QUERY \} from "@\/components\/dispatcher\/dispatcherMobileLayout";/);
  assert.match(source, /window\.matchMedia\(DISPATCHER_DESKTOP_XL_MEDIA_QUERY\)/);
  assert.doesNotMatch(source, /window\.matchMedia\("\(min-width: 1280px\)"\)/);
});
