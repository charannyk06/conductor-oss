import type { WebMcpToolName } from "@/lib/webmcpTools";

export type DemoSessionStatus = "working" | "needs_input" | "review" | "queued" | "completed";

export type DemoDiffFile = {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
};

export type DemoProject = {
  id: string;
  name: string;
  description: string;
  branch: string;
  syntheticLabel: string;
  health: "working" | "attention" | "ready";
};

export type DemoSession = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: DemoSessionStatus;
  agent: string;
  branch: string;
  summary: string;
  prompt: string;
  lastFeedback: string | null;
  syntheticLabel: string;
  diffSummary: string;
  diffFiles: DemoDiffFile[];
  updatedAt: string;
};

export type DemoToolRun = {
  id: string;
  toolName: WebMcpToolName;
  changedState: boolean;
  summary: string;
  outputPreview: string;
  timestamp: string;
};

export type DemoTimelineEvent = {
  id: string;
  label: string;
  timestamp: string;
};

export type DemoState = {
  workspaceName: string;
  workspaceLabel: string;
  projects: DemoProject[];
  sessions: DemoSession[];
  selectedSessionId: string;
  timeline: DemoTimelineEvent[];
  toolRuns: DemoToolRun[];
  nextSyntheticSessionNumber: number;
};

export type DemoStateAction =
  | {
    type: "focus-session";
    sessionId: string;
    timestamp: string;
  }
  | {
    type: "start-agent";
    timestamp: string;
    projectId: string;
    prompt: string;
    agent?: string | null;
  }
  | {
    type: "send-feedback";
    timestamp: string;
    sessionId: string;
    feedback: string;
  }
  | {
    type: "record-tool-run";
    run: DemoToolRun;
  };

function createTimelineEvent(label: string, timestamp: string, suffix: string): DemoTimelineEvent {
  return {
    id: `${suffix}-${timestamp}`,
    label,
    timestamp,
  };
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function createInitialDemoState(): DemoState {
  return {
    workspaceName: "Conductor WebMCP Demo",
    workspaceLabel: "Synthetic data only. In-memory state resets on reload.",
    projects: [
      {
        id: "demo-web",
        name: "demo-web",
        description: "Synthetic public landing route polish pass.",
        branch: "feat/webmcp-demo",
        syntheticLabel: "Synthetic project",
        health: "working",
      },
      {
        id: "demo-core",
        name: "demo-core",
        description: "Synthetic reducer and schema hardening.",
        branch: "feat/tool-safety",
        syntheticLabel: "Synthetic project",
        health: "attention",
      },
      {
        id: "demo-docs",
        name: "demo-docs",
        description: "Synthetic walkthrough and submission prep.",
        branch: "docs/webmcp-judge-flow",
        syntheticLabel: "Synthetic project",
        health: "ready",
      },
    ],
    sessions: [
      {
        id: "demo-session-204",
        projectId: "demo-web",
        projectName: "demo-web",
        title: "Synthetic dashboard polish",
        status: "working",
        agent: "codex",
        branch: "feat/webmcp-demo",
        summary: "Synthetic UI polish pass is updating the public challenge route layout and samples.",
        prompt: "Polish the synthetic `/webmcp` route and make every tool effect visible in the UI.",
        lastFeedback: null,
        syntheticLabel: "Synthetic session",
        diffSummary: "Header layout tightened, inspector panels aligned, mobile spacing reduced.",
        diffFiles: [
          { path: "packages/web/src/app/webmcp/page.tsx", status: "modified", additions: 84, deletions: 11 },
          { path: "packages/web/src/features/webmcp/WebMcpDemoPage.tsx", status: "modified", additions: 129, deletions: 18 },
        ],
        updatedAt: "2026-08-25T13:42:00.000Z",
      },
      {
        id: "demo-session-198",
        projectId: "demo-core",
        projectName: "demo-core",
        title: "Synthetic confirmation gate review",
        status: "needs_input",
        agent: "claude-code",
        branch: "feat/tool-safety",
        summary: "Synthetic session is waiting for explicit approval before sending operator feedback.",
        prompt: "Verify `confirmed: true` is required before any state-changing tool executes.",
        lastFeedback: "Please keep the guard error concise and structured.",
        syntheticLabel: "Synthetic session",
        diffSummary: "Confirmation helpers added, mutation paths now return structured rejection payloads.",
        diffFiles: [
          { path: "packages/web/src/lib/webmcp.ts", status: "modified", additions: 41, deletions: 3 },
          { path: "packages/web/src/lib/webmcpTools.ts", status: "modified", additions: 77, deletions: 0 },
        ],
        updatedAt: "2026-08-25T13:31:00.000Z",
      },
      {
        id: "demo-session-176",
        projectId: "demo-docs",
        projectName: "demo-docs",
        title: "Synthetic judge walkthrough",
        status: "review",
        agent: "gemini",
        branch: "docs/webmcp-judge-flow",
        summary: "Synthetic walkthrough draft is staged for review with clearly labeled fake diffs.",
        prompt: "Prepare judge-facing prompts and explain that this page uses synthetic in-memory data only.",
        lastFeedback: null,
        syntheticLabel: "Synthetic session",
        diffSummary: "Prompt suggestions added, compatibility copy tightened, callout language clarified.",
        diffFiles: [
          { path: "docs/webmcp-challenge-2026.md", status: "modified", additions: 14, deletions: 2 },
          { path: "packages/web/src/features/webmcp/demoState.ts", status: "added", additions: 205, deletions: 0 },
        ],
        updatedAt: "2026-08-25T12:58:00.000Z",
      },
    ],
    selectedSessionId: "demo-session-204",
    timeline: [
      createTimelineEvent("Synthetic workspace loaded for the August 25, 2026 challenge branch.", "2026-08-25T13:40:00.000Z", "init"),
      createTimelineEvent("Browser tools can inspect or mutate only this in-memory demo state.", "2026-08-25T13:41:30.000Z", "init"),
    ],
    toolRuns: [],
    nextSyntheticSessionNumber: 205,
  };
}

function prependTimeline(state: DemoState, event: DemoTimelineEvent): DemoTimelineEvent[] {
  return [event, ...state.timeline].slice(0, 12);
}

function prependToolRun(state: DemoState, run: DemoToolRun): DemoToolRun[] {
  return [run, ...state.toolRuns].slice(0, 12);
}

export function findDemoSession(state: DemoState, sessionId: string): DemoSession | null {
  return state.sessions.find((session) => session.id === sessionId) ?? null;
}

export function findDemoProject(state: DemoState, projectId: string): DemoProject | null {
  return state.projects.find((project) => project.id === projectId) ?? null;
}

export function demoStateReducer(state: DemoState, action: DemoStateAction): DemoState {
  if (action.type === "focus-session") {
    const session = findDemoSession(state, action.sessionId);
    if (!session) {
      return state;
    }
    return {
      ...state,
      selectedSessionId: session.id,
      timeline: prependTimeline(
        state,
        createTimelineEvent(
          `Focused synthetic session ${session.id} in the workspace preview.`,
          action.timestamp,
          "focus",
        ),
      ),
    };
  }

  if (action.type === "start-agent") {
    const project = findDemoProject(state, action.projectId);
    if (!project) {
      return state;
    }

    const nextId = `demo-session-${state.nextSyntheticSessionNumber}`;
    const trimmedPrompt = truncate(action.prompt, 160);
    const nextSession: DemoSession = {
      id: nextId,
      projectId: project.id,
      projectName: project.name,
      title: "Synthetic queued session",
      status: "queued",
      agent: action.agent?.trim() || "codex",
      branch: project.branch,
      summary: "Synthetic session was queued from the public WebMCP demo and no real agent was launched.",
      prompt: trimmedPrompt,
      lastFeedback: null,
      syntheticLabel: "Synthetic session",
      diffSummary: "No diff yet. This is a synthetic pending launch state.",
      diffFiles: [],
      updatedAt: action.timestamp,
    };

    return {
      ...state,
      sessions: [nextSession, ...state.sessions],
      selectedSessionId: nextId,
      timeline: prependTimeline(
        state,
        createTimelineEvent(
          `Queued synthetic session ${nextId} for ${project.id}.`,
          action.timestamp,
          "spawn",
        ),
      ),
      nextSyntheticSessionNumber: state.nextSyntheticSessionNumber + 1,
    };
  }

  if (action.type === "send-feedback") {
    const session = findDemoSession(state, action.sessionId);
    if (!session) {
      return state;
    }
    const nextSessions = state.sessions.map((entry) => {
      if (entry.id !== action.sessionId) {
        return entry;
      }
      return {
        ...entry,
        status: "working" as DemoSessionStatus,
        summary: "Synthetic follow-up feedback was accepted and the session returned to working status.",
        lastFeedback: truncate(action.feedback, 160),
        updatedAt: action.timestamp,
      };
    });

    return {
      ...state,
      sessions: nextSessions,
      selectedSessionId: action.sessionId,
      timeline: prependTimeline(
        state,
        createTimelineEvent(
          `Sent synthetic feedback to ${action.sessionId}.`,
          action.timestamp,
          "feedback",
        ),
      ),
    };
  }

  if (action.type === "record-tool-run") {
    return {
      ...state,
      toolRuns: prependToolRun(state, action.run),
    };
  }

  return state;
}
