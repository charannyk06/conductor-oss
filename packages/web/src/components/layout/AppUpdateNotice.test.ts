import assert from "node:assert/strict";
import test from "node:test";
import { noticeTitle } from "./AppUpdateNotice";
import type { AppUpdateStatus } from "@/lib/types";

test("noticeTitle includes the installed build version when already up to date", () => {
  const status = {
    enabled: true,
    reason: null,
    jobStatus: "idle",
    updateAvailable: false,
    currentVersion: "0.3.4",
    latestVersion: null,
  } as AppUpdateStatus;

  assert.equal(noticeTitle(status), "Conductor update available (build 0.3.4)");
});

test("noticeTitle includes the installed build version alongside an available release", () => {
  const status = {
    enabled: true,
    reason: null,
    jobStatus: "idle",
    updateAvailable: true,
    currentVersion: "0.3.4",
    latestVersion: "0.3.5",
  } as AppUpdateStatus;

  assert.equal(noticeTitle(status), "Conductor 0.3.5 is available (build 0.3.4)");
});
