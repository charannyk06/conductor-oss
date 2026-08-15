import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("app shell owns a bounded safe-area viewport rather than document scrolling", () => {
  const source = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

  assert.match(source, /h-\[var\(--oc-shell-height\)\]/);
  assert.match(source, /max-h-\[var\(--oc-shell-height\)\]/);
  assert.match(source, /overflow-hidden/);
  assert.match(source, /safe-area-inset-top/);
  assert.match(source, /safe-area-inset-bottom/);
});

test("inactive mounted session workspaces cannot swallow mobile touch gestures", () => {
  const dashboardSource = readFileSync(
    new URL("../../features/dashboard/DashboardClient.tsx", import.meta.url),
    "utf8",
  );
  const sessionSource = readFileSync(new URL("../sessions/SessionDetail.tsx", import.meta.url), "utf8");

  assert.match(dashboardSource, /pointer-events-none absolute inset-0 overflow-hidden opacity-0 select-none/);
  assert.match(sessionSource, /data-\[state=inactive\]:pointer-events-none/);
  assert.match(sessionSource, /data-\[state=active\]:z-10/);
  assert.match(sessionSource, /data-\[state=inactive\]:z-0/);
});

test("primary tabs retain 44px mobile targets and compact desktop sizing", () => {
  const tabsSource = readFileSync(new URL("../ui/Tabs.tsx", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../sessions/SessionDetail.tsx", import.meta.url), "utf8");

  assert.match(tabsSource, /min-h-11/);
  assert.match(tabsSource, /oc-mobile-touch-target/);
  assert.match(tabsSource, /sm:min-h-\[34px\]/);
  assert.match(sessionSource, /tabTriggerClass = "min-h-11/);
  assert.doesNotMatch(sessionSource, /tabTriggerClass = "[^"]*sm:min-h-0/);
});

test("mobile workspace sidebar controls use finger-sized targets", () => {
  const sidebarSource = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
  const workspaceSidebarSource = readFileSync(
    new URL("./WorkspaceSidebarPanel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(sidebarSource, /<label className="oc-mobile-touch-target flex h-11/);
  assert.match(sidebarSource, /inline-flex h-11 w-11[^\n]*sm:h-7 sm:w-7/);
  assert.match(workspaceSidebarSource, /flex min-h-11 w-full/);
  assert.match(workspaceSidebarSource, /inline-flex h-11 w-11/);
  assert.match(workspaceSidebarSource, /aria-label="Close workspace panel"/);
  assert.match(workspaceSidebarSource, /absolute right-4 top-4 inline-flex h-11 w-11/);
});

test("top bar contains its 44px mobile menu targets", () => {
  const source = readFileSync(new URL("./TopBar.tsx", import.meta.url), "utf8");
  const dashboardSource = readFileSync(
    new URL("../../features/dashboard/DashboardClient.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /<header className="oc-mobile-touch-target flex h-11 shrink-0/);
  assert.match(source, /sm:h-\[33px\]/);
  assert.match(source, /inline-flex h-11 w-11[^\n]*sm:h-8 sm:w-8/);
  assert.match(dashboardSource, /className=\{`hidden items-center[^`]*sm:inline-flex \$\{scopeBadgeClassName\}`\}/);
});
