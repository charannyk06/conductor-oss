import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardSessionSelection } from "./dashboardSessionSelection";

test("board session selection exits board mode and opens the session directly", () => {
  assert.deepEqual(
    buildDashboardSessionSelection(
      "session-1",
      {
        projectId: "openclaw",
        metadata: { sessionKind: "task" } as Record<string, string>,
      },
      "fallback-project",
      "board",
    ),
    {
      projectId: "openclaw",
      sessionId: "session-1",
      tab: "terminal",
      workspaceView: "direct",
    },
  );
});

test("direct session selection preserves an explicit tab without changing workspace view", () => {
  assert.deepEqual(
    buildDashboardSessionSelection(
      "session-2",
      {
        projectId: "openclaw",
        metadata: { sessionKind: "project_dispatcher" } as Record<string, string>,
      },
      null,
      "direct",
      "overview",
    ),
    {
      projectId: "openclaw",
      sessionId: "session-2",
      tab: "overview",
    },
  );
});
