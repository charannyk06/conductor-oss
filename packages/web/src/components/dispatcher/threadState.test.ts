import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardSession } from "@/lib/types";
import {
  reconcileDeletedDispatcherThread,
  resolveSelectedDispatcherThreadId,
  sortDispatcherThreadsByActivity,
  upsertDispatcherThread,
} from "./threadState";

function buildThread(id: string, lastActivityAt: string): DashboardSession {
  return {
    id,
    projectId: "demo",
    bridgeId: null,
    bridgeConnected: null,
    bridgeConnection: null,
    status: "idle",
    activity: null,
    branch: null,
    issueId: null,
    summary: null,
    createdAt: lastActivityAt,
    lastActivityAt,
    pr: null,
    metadata: {},
  };
}

test("resolveSelectedDispatcherThreadId keeps the current selection when it still exists", () => {
  const threads = sortDispatcherThreadsByActivity([
    buildThread("thread-1", "2026-03-29T10:00:00Z"),
    buildThread("thread-2", "2026-03-29T11:00:00Z"),
  ]);

  assert.equal(
    resolveSelectedDispatcherThreadId("thread-1", threads, "thread-2"),
    "thread-1",
  );
});

test("resolveSelectedDispatcherThreadId falls back to the active thread and then the newest thread", () => {
  const threads = sortDispatcherThreadsByActivity([
    buildThread("thread-1", "2026-03-29T10:00:00Z"),
    buildThread("thread-2", "2026-03-29T11:00:00Z"),
  ]);

  assert.equal(
    resolveSelectedDispatcherThreadId("missing", threads, "thread-1"),
    "thread-1",
  );
  assert.equal(resolveSelectedDispatcherThreadId("missing", threads, null), "thread-2");
});

test("upsertDispatcherThread replaces an existing thread and preserves activity sorting", () => {
  const threads = sortDispatcherThreadsByActivity([
    buildThread("thread-1", "2026-03-29T10:00:00Z"),
    buildThread("thread-2", "2026-03-29T11:00:00Z"),
  ]);

  const next = upsertDispatcherThread(
    threads,
    buildThread("thread-1", "2026-03-29T12:00:00Z"),
  );

  assert.deepEqual(
    next.map((thread) => thread.id),
    ["thread-1", "thread-2"],
  );
});

test("reconcileDeletedDispatcherThread keeps the selection when another thread is deleted", () => {
  const threads = sortDispatcherThreadsByActivity([
    buildThread("thread-1", "2026-03-29T10:00:00Z"),
    buildThread("thread-2", "2026-03-29T11:00:00Z"),
    buildThread("thread-3", "2026-03-29T12:00:00Z"),
  ]);

  const next = reconcileDeletedDispatcherThread(threads, "thread-2", "thread-1");

  assert.equal(next.selectedThreadId, "thread-2");
  assert.deepEqual(
    next.threads.map((thread) => thread.id),
    ["thread-3", "thread-2"],
  );
});

test("reconcileDeletedDispatcherThread selects the next newest thread after deleting the current one", () => {
  const threads = sortDispatcherThreadsByActivity([
    buildThread("thread-1", "2026-03-29T10:00:00Z"),
    buildThread("thread-2", "2026-03-29T11:00:00Z"),
    buildThread("thread-3", "2026-03-29T12:00:00Z"),
  ]);

  const next = reconcileDeletedDispatcherThread(threads, "thread-3", "thread-3");

  assert.equal(next.selectedThreadId, "thread-2");
  assert.deepEqual(
    next.threads.map((thread) => thread.id),
    ["thread-2", "thread-1"],
  );
});
