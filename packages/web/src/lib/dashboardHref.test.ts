import assert from "node:assert/strict";
import test from "node:test";
import { buildAllProjectsHref, buildSessionHref } from "./dashboardHref";

test("buildAllProjectsHref targets the all-projects dashboard root", () => {
  assert.equal(buildAllProjectsHref(), "/");
  assert.equal(buildAllProjectsHref(""), "/");
  assert.equal(buildAllProjectsHref("bridge-demo"), "/?bridge=bridge-demo");
});

test("buildSessionHref keeps local sessions on their plain route", () => {
  assert.equal(buildSessionHref("session-1"), "/sessions/session-1");
  assert.equal(buildSessionHref("session-1", { tab: "terminal" }), "/sessions/session-1?tab=terminal");
});

test("buildSessionHref encodes paired-device scope into the route session id", () => {
  assert.equal(
    buildSessionHref("session-1", { bridgeId: "bridge-demo", tab: "terminal" }),
    "/sessions/bridge%3Abridge-demo%3Asession-1?tab=terminal",
  );
});

test("buildSessionHref preserves an already-encoded bridge session id", () => {
  assert.equal(
    buildSessionHref("bridge:bridge-demo:session-1", { bridgeId: "bridge-other", tab: "terminal" }),
    "/sessions/bridge%3Abridge-demo%3Asession-1?tab=terminal",
  );
});
