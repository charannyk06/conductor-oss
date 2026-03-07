import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEventBus } from "./event-bus.js";
import type { OrchestratorEvent } from "./types.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: randomUUID(),
    type: "session.exited",
    priority: "info",
    sessionId: "test-session",
    projectId: "test-project",
    timestamp: new Date(),
    message: "Test event",
    data: {},
    ...overrides,
  };
}

describe("event-bus", () => {
  it("emits and queries events", () => {
    const bus = createEventBus();
    const event = makeEvent();
    bus.emit(event);

    const results = bus.query({});
    assert.equal(results.length, 1);
    assert.equal(results[0].id, event.id);
  });

  it("filters by project and session", () => {
    const bus = createEventBus();
    bus.emit(makeEvent({ projectId: "proj-a", sessionId: "s1" }));
    bus.emit(makeEvent({ projectId: "proj-b", sessionId: "s2" }));

    const byProject = bus.query({ projectId: "proj-a" });
    assert.equal(byProject.length, 1);

    const bySession = bus.query({ sessionId: "s2" });
    assert.equal(bySession.length, 1);
  });

  it("limits query results", () => {
    const bus = createEventBus();
    for (let i = 0; i < 10; i++) {
      bus.emit(makeEvent());
    }

    const limited = bus.query({ limit: 3 });
    assert.equal(limited.length, 3);
  });

  it("tracks pending urgent events", () => {
    const bus = createEventBus();
    bus.emit(makeEvent({ priority: "urgent" }));
    bus.emit(makeEvent({ priority: "info" }));
    bus.emit(makeEvent({ priority: "action" }));

    const pending = bus.pending();
    assert.equal(pending.length, 2); // urgent + action
  });

  it("acknowledges events", () => {
    const bus = createEventBus();
    const event = makeEvent({ priority: "urgent" });
    bus.emit(event);

    assert.equal(bus.pending().length, 1);
    const acked = bus.acknowledge(event.id);
    assert.ok(acked);
    assert.equal(bus.pending().length, 0);
  });

  it("notifies subscribers", () => {
    const bus = createEventBus();
    const received: OrchestratorEvent[] = [];

    bus.subscribe({
      id: "test-sub",
      callback: (e) => received.push(e),
    });

    bus.emit(makeEvent());
    assert.equal(received.length, 1);
  });

  it("respects subscriber filters", () => {
    const bus = createEventBus();
    const received: OrchestratorEvent[] = [];

    bus.subscribe({
      id: "test-sub",
      filter: { projectId: "proj-a" },
      callback: (e) => received.push(e),
    });

    bus.emit(makeEvent({ projectId: "proj-a" }));
    bus.emit(makeEvent({ projectId: "proj-b" }));
    assert.equal(received.length, 1);
  });

  it("unsubscribe works", () => {
    const bus = createEventBus();
    const received: OrchestratorEvent[] = [];

    const unsub = bus.subscribe({
      id: "test-sub",
      callback: (e) => received.push(e),
    });

    bus.emit(makeEvent());
    assert.equal(received.length, 1);

    unsub();
    bus.emit(makeEvent());
    assert.equal(received.length, 1); // no new events after unsub
  });

  it("trims buffer at max size", () => {
    const bus = createEventBus({ maxBufferSize: 5 });
    for (let i = 0; i < 10; i++) {
      bus.emit(makeEvent());
    }

    const metrics = bus.metrics();
    assert.equal(metrics.bufferSize, 5);
    assert.equal(metrics.totalEmitted, 10);
  });

  it("clear resets everything", () => {
    const bus = createEventBus();
    bus.emit(makeEvent({ priority: "urgent" }));
    bus.subscribe({ id: "s", callback: () => {} });

    bus.clear();
    assert.equal(bus.metrics().bufferSize, 0);
    assert.equal(bus.metrics().subscriberCount, 0);
    assert.equal(bus.metrics().pendingCount, 0);
  });
});
