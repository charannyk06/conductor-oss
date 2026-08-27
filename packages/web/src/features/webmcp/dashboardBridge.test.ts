import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardWebMcpTools } from "./dashboardBridge";

test("dashboard WebMCP mutation tools reject unconfirmed requests before fetch", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    const tools = createDashboardWebMcpTools({
      getBridgeId: () => "bridge-demo",
      getSelection: () => ({ selectedProjectId: "demo-web", selectedSessionId: "session-1" }),
      navigateDashboard: () => {},
      refreshSessions: async () => {},
    });
    const focusTool = tools.find((tool) => tool.name === "conductor_focus_session");
    const startTool = tools.find((tool) => tool.name === "conductor_start_agent");
    const feedbackTool = tools.find((tool) => tool.name === "conductor_send_feedback");
    assert.ok(focusTool);
    assert.ok(startTool);
    assert.ok(feedbackTool);

    const focusResult = JSON.parse(await focusTool!.execute({
      sessionId: "session-1",
      confirmed: false,
    })) as { requiresConfirmation?: boolean };
    const startResult = JSON.parse(await startTool!.execute({
      projectId: "demo-web",
      prompt: "Unsafe without confirmation",
      confirmed: false,
    })) as { requiresConfirmation?: boolean };
    const feedbackResult = JSON.parse(await feedbackTool!.execute({
      sessionId: "session-1",
      feedback: "Unsafe without confirmation",
      confirmed: false,
    })) as { requiresConfirmation?: boolean };

    assert.equal(focusResult.requiresConfirmation, true);
    assert.equal(startResult.requiresConfirmation, true);
    assert.equal(feedbackResult.requiresConfirmation, true);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("dashboard WebMCP preserves bridge scope and forwards execution cancellation", async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  let requestUrl = "";
  let requestSignal: AbortSignal | null | undefined;
  let navigatedBridgeId: string | null | undefined;

  global.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestSignal = init?.signal;
    return Response.json({
      id: "bridge:remote-7:session-42",
      projectId: "demo-web",
      status: "working",
      activity: "active",
      agent: "codex",
      branch: "feat/webmcp",
      summary: "Remote synthetic summary",
      createdAt: "2026-08-25T20:00:00.000Z",
      lastActivityAt: "2026-08-25T20:10:00.000Z",
      metadata: {},
    });
  }) as typeof fetch;

  try {
    const tools = createDashboardWebMcpTools({
      getBridgeId: () => null,
      getSelection: () => ({ selectedProjectId: null, selectedSessionId: null }),
      navigateDashboard: (updates) => {
        navigatedBridgeId = updates.bridgeId;
      },
      refreshSessions: async () => {},
      requestHumanConfirmation: async () => true,
    });
    const focusTool = tools.find((tool) => tool.name === "conductor_focus_session");
    assert.ok(focusTool);

    const result = JSON.parse(await focusTool!.execute({
      sessionId: "bridge:remote-7:session-42",
      confirmed: true,
    }, { signal: controller.signal })) as { bridgeScope?: string };

    assert.equal(result.bridgeScope, "remote-7");
    assert.equal(navigatedBridgeId, "remote-7");
    assert.match(requestUrl, /bridgeId=remote-7/);
    assert.equal(requestSignal, controller.signal);
  } finally {
    global.fetch = originalFetch;
  }
});

test("dashboard WebMCP read tools unwrap the live sessions response envelope", async () => {
  const originalFetch = global.fetch;
  const seenUrls: string[] = [];
  global.fetch = (async (input) => {
    const url = String(input);
    seenUrls.push(url);
    if (url.startsWith("/api/projects")) {
      return Response.json([{
        id: "project-1",
        name: "Project One",
        path: "/private/should-not-leak",
        defaultExecutor: "codex",
        maxSessions: 5,
      }]);
    }
    if (url.startsWith("/api/sessions")) {
      return Response.json({
        sessions: [{
          id: "session-1",
          projectId: "project-1",
          status: "working",
          activity: "active",
          agent: "codex",
          branch: "feat/webmcp",
          summary: "A bounded session summary.",
          createdAt: "2026-08-25T21:00:00.000Z",
          lastActivityAt: "2026-08-25T21:05:00.000Z",
          metadata: {},
        }],
        stats: { totalSessions: 1 },
      });
    }
    return Response.json({ error: "Unexpected test URL" }, { status: 404 });
  }) as typeof fetch;

  try {
    const tools = createDashboardWebMcpTools({
      getBridgeId: () => "bridge-demo",
      getSelection: () => ({ selectedProjectId: "project-1", selectedSessionId: "session-1" }),
      navigateDashboard: () => {},
      refreshSessions: async () => {},
    });
    const overviewTool = tools.find((tool) => tool.name === "conductor_get_workspace_overview");
    const sessionsTool = tools.find((tool) => tool.name === "conductor_list_sessions");
    assert.ok(overviewTool);
    assert.ok(sessionsTool);

    const overview = JSON.parse(await overviewTool!.execute({ projectId: "project-1" })) as {
      projects?: unknown[];
      sessions?: unknown[];
    };
    const listed = JSON.parse(await sessionsTool!.execute({ projectId: "project-1" })) as {
      sessions?: unknown[];
    };

    assert.equal(overview.projects?.length, 1);
    assert.equal(overview.sessions?.length, 1);
    assert.equal(listed.sessions?.length, 1);
    assert.doesNotMatch(JSON.stringify(overview), /should-not-leak/);
    assert.ok(seenUrls.every((url) => url.includes("bridgeId=bridge-demo")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("dashboard WebMCP rejects oversized mutation input before approval or fetch", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  let approvalCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    const tools = createDashboardWebMcpTools({
      getBridgeId: () => null,
      getSelection: () => ({ selectedProjectId: null, selectedSessionId: null }),
      navigateDashboard: () => {},
      refreshSessions: async () => {},
      requestHumanConfirmation: async () => {
        approvalCalls += 1;
        return true;
      },
    });
    const startTool = tools.find((tool) => tool.name === "conductor_start_agent");
    assert.ok(startTool);

    const result = JSON.parse(await startTool!.execute({
      projectId: "demo-web",
      prompt: "x".repeat(4_001),
      confirmed: true,
    })) as { error?: string };

    assert.match(result.error ?? "", /prompt must be at most 4000 characters/i);
    assert.equal(approvalCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("dashboard WebMCP requires person approval after confirmed input", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    const tools = createDashboardWebMcpTools({
      getBridgeId: () => null,
      getSelection: () => ({ selectedProjectId: null, selectedSessionId: null }),
      navigateDashboard: () => {},
      refreshSessions: async () => {},
      requestHumanConfirmation: async () => false,
    });
    const focusTool = tools.find((tool) => tool.name === "conductor_focus_session");
    assert.ok(focusTool);

    const result = JSON.parse(await focusTool!.execute({
      sessionId: "demo-session-176",
      confirmed: true,
    })) as { requiresHumanApproval?: boolean };

    assert.equal(result.requiresHumanApproval, true);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("dashboard WebMCP caps session lists at twelve records", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => Response.json({
    sessions: Array.from({ length: 20 }, (_, index) => ({
      id: `session-${index}`,
      projectId: "project-1",
      status: "working",
      activity: "active",
      agent: "codex",
      branch: "feat/webmcp",
      summary: "A bounded session summary.",
      createdAt: "2026-08-25T21:00:00.000Z",
      lastActivityAt: "2026-08-25T21:05:00.000Z",
      metadata: {},
    })),
    stats: { totalSessions: 20 },
  })) as typeof fetch;

  try {
    const tools = createDashboardWebMcpTools({
      getBridgeId: () => null,
      getSelection: () => ({ selectedProjectId: null, selectedSessionId: null }),
      navigateDashboard: () => {},
      refreshSessions: async () => {},
    });
    const sessionsTool = tools.find((tool) => tool.name === "conductor_list_sessions");
    assert.ok(sessionsTool);

    const result = JSON.parse(await sessionsTool!.execute({ limit: 25 })) as { sessions?: unknown[] };
    assert.equal(result.sessions?.length, 12);
  } finally {
    global.fetch = originalFetch;
  }
});
