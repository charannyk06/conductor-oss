import assert from "node:assert/strict";
import test from "node:test";
import { createInitialDemoState, demoStateReducer, type DemoStateAction } from "./demoState";
import { createDemoWebMcpTools } from "./demoTools";

test("demo WebMCP tools reject malformed inputs deterministically", async () => {
  let state = createInitialDemoState();
  const tools = createDemoWebMcpTools(
    () => state,
    (action: DemoStateAction) => {
      state = demoStateReducer(state, action);
    },
  );

  const inspectTool = tools.find((tool) => tool.name === "conductor_inspect_session");
  const startTool = tools.find((tool) => tool.name === "conductor_start_agent");
  const feedbackTool = tools.find((tool) => tool.name === "conductor_send_feedback");
  assert.ok(inspectTool);
  assert.ok(startTool);
  assert.ok(feedbackTool);

  const inspectResult = JSON.parse(await inspectTool!.execute(undefined as never)) as { error?: string };
  const startResult = JSON.parse(await startTool!.execute({ confirmed: true } as never)) as { error?: string };
  const feedbackResult = JSON.parse(await feedbackTool!.execute({ confirmed: true } as never)) as { error?: string };

  assert.equal(inspectResult.error, "sessionId is required.");
  assert.equal(startResult.error, "projectId and prompt are required.");
  assert.equal(feedbackResult.error, "sessionId and feedback are required.");
});

test("demo focus tool requires confirmation before visible state changes", async () => {
  let state = createInitialDemoState();
  const initialSessionId = state.selectedSessionId;
  const tools = createDemoWebMcpTools(
    () => state,
    (action: DemoStateAction) => {
      state = demoStateReducer(state, action);
    },
  );
  const focusTool = tools.find((tool) => tool.name === "conductor_focus_session");
  assert.ok(focusTool);

  const result = JSON.parse(await focusTool!.execute({
    sessionId: "demo-session-176",
    confirmed: false,
  })) as { requiresConfirmation?: boolean };

  assert.equal(result.requiresConfirmation, true);
  assert.equal(state.selectedSessionId, initialSessionId);
});

test("demo tool activity ids stay unique for same-millisecond WebMCP calls", async () => {
  let state = createInitialDemoState();
  const runIds: string[] = [];
  const tools = createDemoWebMcpTools(
    () => state,
    (action: DemoStateAction) => {
      if (action.type === "record-tool-run") {
        runIds.push(action.run.id);
      }
      state = demoStateReducer(state, action);
    },
    async () => true,
  );
  const focusTool = tools.find((tool) => tool.name === "conductor_focus_session");
  assert.ok(focusTool);

  const originalNow = Date.now;
  Date.now = () => 123456789;
  try {
    await focusTool!.execute({ sessionId: "demo-session-176", confirmed: false });
    await focusTool!.execute({ sessionId: "demo-session-176", confirmed: true });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(runIds.length, 2);
  assert.equal(new Set(runIds).size, 2);
});

test("demo WebMCP rejects oversized mutation input before approval or state change", async () => {
  let state = createInitialDemoState();
  const initialCount = state.sessions.length;
  let approvalCalls = 0;
  const tools = createDemoWebMcpTools(
    () => state,
    (action: DemoStateAction) => {
      state = demoStateReducer(state, action);
    },
    async () => {
      approvalCalls += 1;
      return true;
    },
  );
  const startTool = tools.find((tool) => tool.name === "conductor_start_agent");
  assert.ok(startTool);

  const result = JSON.parse(await startTool!.execute({
    projectId: "demo-web",
    prompt: "x".repeat(4_001),
    confirmed: true,
  })) as { error?: string };

  assert.match(result.error ?? "", /prompt must be at most 4000 characters/i);
  assert.equal(approvalCalls, 0);
  assert.equal(state.sessions.length, initialCount);
});
