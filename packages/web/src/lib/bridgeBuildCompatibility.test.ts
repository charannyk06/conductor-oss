import assert from "node:assert/strict";
import test from "node:test";
import {
  describeLegacyBridgeBuild,
  isLegacyBridgeBuildErrorMessage,
  legacyBridgeBuildActionMessage,
} from "./bridgeBuildCompatibility";

test("detects backend marker errors from older bridge builds", () => {
  assert.equal(
    isLegacyBridgeBuildErrorMessage("dial tcp 127.0.0.1:4749: connect: connection refused"),
    true,
  );
});

test("detects already-normalized legacy bridge messages", () => {
  assert.equal(
    isLegacyBridgeBuildErrorMessage("This laptop is still on an older bridge build."),
    true,
  );
  assert.equal(
    isLegacyBridgeBuildErrorMessage("This laptop needs a one-time local bridge upgrade before Update Conductor can run from the dashboard."),
    true,
  );
});

test("ignores unrelated bridge failures", () => {
  assert.equal(
    isLegacyBridgeBuildErrorMessage("Failed to attach relay terminal (500)"),
    false,
  );
});

test("describes the one-time bridge upgrade requirement", () => {
  assert.equal(
    legacyBridgeBuildActionMessage("update"),
    "This laptop needs a one-time local bridge upgrade before Update Conductor can run from the dashboard.",
  );
  assert.match(
    describeLegacyBridgeBuild("Studio Mac"),
    /Studio Mac is still on an older bridge build/,
  );
});
