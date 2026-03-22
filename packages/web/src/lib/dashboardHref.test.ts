import assert from "node:assert/strict";
import test from "node:test";
import { buildAllProjectsHref } from "./dashboardHref";

test("buildAllProjectsHref targets the all-projects dashboard root", () => {
  assert.equal(buildAllProjectsHref(), "/");
  assert.equal(buildAllProjectsHref(""), "/");
  assert.equal(buildAllProjectsHref("bridge-demo"), "/?bridge=bridge-demo");
});
