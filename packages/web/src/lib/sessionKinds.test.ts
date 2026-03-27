import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultSessionPrimaryTab, isProjectDispatcherSession } from "./sessionKinds";

test("getDefaultSessionPrimaryTab defaults every session to chat", () => {
  assert.equal(getDefaultSessionPrimaryTab(null), "chat");
  assert.equal(getDefaultSessionPrimaryTab({ metadata: {} as Record<string, string> }), "chat");
  assert.equal(
    getDefaultSessionPrimaryTab({
      metadata: { sessionKind: "project_dispatcher" } as Record<string, string>,
    }),
    "chat",
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
