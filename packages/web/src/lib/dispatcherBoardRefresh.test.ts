import assert from "node:assert/strict";
import test from "node:test";
import {
  findDispatcherBoardRefreshReason,
  shouldRefreshProjectBoardFromSnapshotEvent,
} from "./dispatcherBoardRefresh";

test("findDispatcherBoardRefreshReason detects dispatcher board lifecycle events", () => {
  assert.equal(
    findDispatcherBoardRefreshReason([
      {
        kind: "system",
        metadata: { eventType: "dispatcher_task_created" },
      },
    ]),
    "dispatcher_task_created",
  );
});

test("findDispatcherBoardRefreshReason ignores non-board dispatcher events", () => {
  assert.equal(
    findDispatcherBoardRefreshReason([
      {
        kind: "system",
        metadata: { eventType: "dispatcher_session_completed" },
      },
      {
        kind: "assistant",
        metadata: { eventType: "dispatcher_task_created" },
      },
    ]),
    null,
  );
});

test("shouldRefreshProjectBoardFromSnapshotEvent refreshes when the snapshot touches the project", () => {
  assert.equal(
    shouldRefreshProjectBoardFromSnapshotEvent(
      {
        type: "snapshot_delta",
        sessions: [{ id: "s-1", projectId: "demo" }] as never[],
      },
      "demo",
    ),
    true,
  );
});

test("shouldRefreshProjectBoardFromSnapshotEvent refreshes when changedProjectIds includes the project", () => {
  assert.equal(
    shouldRefreshProjectBoardFromSnapshotEvent(
      {
        type: "snapshot_delta",
        sessions: [],
        changedProjectIds: ["demo"],
      },
      "demo",
    ),
    true,
  );
});

test("shouldRefreshProjectBoardFromSnapshotEvent refreshes on empty dispatcher-only deltas", () => {
  assert.equal(
    shouldRefreshProjectBoardFromSnapshotEvent(
      {
        type: "snapshot_delta",
        sessions: [],
      },
      "demo",
    ),
    true,
  );
});

test("shouldRefreshProjectBoardFromSnapshotEvent ignores unrelated non-empty deltas", () => {
  assert.equal(
    shouldRefreshProjectBoardFromSnapshotEvent(
      {
        type: "snapshot_delta",
        sessions: [{ id: "s-2", projectId: "other" }] as never[],
      },
      "demo",
    ),
    false,
  );
});
