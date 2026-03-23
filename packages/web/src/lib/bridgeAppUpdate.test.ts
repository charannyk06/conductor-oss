import assert from "node:assert/strict";
import test from "node:test";
import { describeAutoUpdateSkip } from "./bridgeAppUpdate";
import type { AppUpdateStatus } from "./types";

test("describeAutoUpdateSkip hides low-level metadata failures behind a user-facing message", () => {
  const status = {
    enabled: false,
    reason: "missing-cli-metadata",
  } as AppUpdateStatus;

  assert.equal(
    describeAutoUpdateSkip(status),
    "This install could not determine its update metadata, so automatic package updates are unavailable.",
  );
});

test("describeAutoUpdateSkip keeps source checkout messaging explicit", () => {
  const status = {
    enabled: false,
    reason: "source-checkout",
  } as AppUpdateStatus;

  assert.equal(
    describeAutoUpdateSkip(status),
    "This laptop is running from a source checkout, so there is no published package to auto-update.",
  );
});

test("describeAutoUpdateSkip includes the current build version when already up to date", () => {
  const status = {
    enabled: true,
    reason: null,
    updateAvailable: false,
    currentVersion: "0.3.4",
  } as AppUpdateStatus;

  assert.equal(
    describeAutoUpdateSkip(status),
    "This laptop is already running the latest Conductor release (build 0.3.4).",
  );
});
