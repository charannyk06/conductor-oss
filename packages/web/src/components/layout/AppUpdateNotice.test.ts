import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { noticeTitle } from "./AppUpdateNotice";
import type { AppUpdateStatus } from "@/lib/types";

test("noticeTitle labels package versions explicitly when already up to date", () => {
  const status = {
    enabled: true,
    reason: null,
    jobStatus: "idle",
    updateAvailable: false,
    currentVersion: "0.3.4",
    latestVersion: null,
  } as AppUpdateStatus;

  assert.equal(noticeTitle(status), "Conductor package is up to date (installed package 0.3.4)");
});

test("noticeTitle labels package versions explicitly alongside an available release", () => {
  const status = {
    enabled: true,
    reason: null,
    jobStatus: "idle",
    updateAvailable: true,
    currentVersion: "0.3.4",
    latestVersion: "0.3.5",
  } as AppUpdateStatus;

  assert.equal(noticeTitle(status), "Conductor package 0.3.5 is available (installed package 0.3.4)");
});

test("mobile update notice collapses into a compact card instead of covering the whole workspace", () => {
  const source = readFileSync(new URL("./AppUpdateNotice.tsx", import.meta.url), "utf8");

  assert.match(source, /window\.matchMedia\("\(max-width: 639px\)"\)/);
  assert.match(source, /compactNotice/);
  assert.match(source, /mobileExpanded/);
  assert.match(source, /Details/);
  assert.match(source, /oc-mobile-touch-target inline-flex min-h-11 min-w-11/);
  assert.match(source, /sm:min-h-7 sm:min-w-0 sm:px-2/);
  assert.match(source, /Dismiss update notice/);
  assert.match(source, /oc-mobile-touch-target inline-flex h-11 w-11/);
  assert.match(source, /sm:h-7 sm:w-7/);
});
