import assert from "node:assert/strict";
import test from "node:test";
import {
  resetTerminalAttachScheduler,
  scheduleTerminalAttach,
} from "./terminalAttachScheduler";

test.afterEach(() => {
  resetTerminalAttachScheduler();
});

test("scheduleTerminalAttach limits concurrent bootstraps and preserves queue priority", () => {
  const started: string[] = [];
  const completions = new Map<string, () => void>();

  const createTask = (sessionId: string, priority: number) => scheduleTerminalAttach({
    sessionId,
    priority,
    run: (done) => {
      started.push(sessionId);
      completions.set(sessionId, done);
    },
  });

  const cancelA = createTask("session-a", 1);
  const cancelB = createTask("session-b", 1);
  const cancelC = createTask("session-c", 1);
  const cancelD = createTask("session-d", 5);
  const cancelE = createTask("session-e", 0);

  assert.deepEqual(started, ["session-a", "session-b", "session-c"]);

  completions.get("session-a")?.();
  assert.deepEqual(started, ["session-a", "session-b", "session-c", "session-e"]);

  completions.get("session-b")?.();
  assert.deepEqual(started, [
    "session-a",
    "session-b",
    "session-c",
    "session-e",
    "session-d",
  ]);

  cancelA();
  cancelB();
  cancelC();
  cancelD();
  cancelE();
});

test("scheduleTerminalAttach replaces pending work for the same session", () => {
  const started: string[] = [];
  let releaseRunning = (): void => {};

  scheduleTerminalAttach({
    sessionId: "session-1",
    priority: 0,
    run: (done) => {
      started.push("first");
      releaseRunning = done;
    },
  });

  scheduleTerminalAttach({
    sessionId: "session-1",
    priority: 0,
    run: (done) => {
      started.push("second");
      done();
    },
  });

  assert.deepEqual(started, ["first"]);

  releaseRunning();

  assert.deepEqual(started, ["first", "second"]);
});

test("canceling a running attach releases the slot for the replacement task", () => {
  const started: string[] = [];

  const cancelFirst = scheduleTerminalAttach({
    sessionId: "session-1",
    priority: 0,
    run: () => {
      started.push("first");
    },
  });

  scheduleTerminalAttach({
    sessionId: "session-1",
    priority: 0,
    run: (done) => {
      started.push("second");
      done();
    },
  });

  assert.deepEqual(started, ["first"]);

  cancelFirst();

  assert.deepEqual(started, ["first", "second"]);
});
