import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultSessionPrimaryTab, isProjectDispatcherSession } from "./sessionKinds";

test("getDefaultSessionPrimaryTab keeps regular sessions terminal-first", () => {
  assert.equal(getDefaultSessionPrimaryTab(null), "terminal");
  assert.equal(getDefaultSessionPrimaryTab({ metadata: {} as Record<string, string> }), "terminal");
  assert.equal(
    getDefaultSessionPrimaryTab({
      metadata: { sessionKind: "project_dispatcher" } as Record<string, string>,
    }),
    "dispatcher",
  );
});

test("isProjectDispatcherSession still recognizes dispatcher sessions", () => {
  assert.equal(isProjectDispatcherSession(null), false);
  assert.equal(
    isProjectDispatcherSession({
      metadata: { sessionKind: "project_dispatcher" } as Record<string, string>,
    }),
    true,
  );
  assert.equal(
    isProjectDispatcherSession({
      metadata: { sessionKind: "task" } as Record<string, string>,
    }),
    false,
  );
});
