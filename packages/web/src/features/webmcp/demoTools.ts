import {
  browserHumanConfirmation,
  executeToolSafely,
  readBoundedString,
  requireConfirmedMutation,
  requireHumanConfirmation,
  type HumanConfirmationHandler,
  type WebMcpToolDefinition,
} from "@/lib/webmcp";
import {
  createWebMcpTool,
  WEBMCP_INPUT_LIMITS,
  WEBMCP_TOOL_ORDER,
  type WebMcpToolName,
} from "@/lib/webmcpTools";
import {
  demoStateReducer,
  findDemoProject,
  findDemoSession,
  type DemoSession,
  type DemoState,
  type DemoStateAction,
} from "@/features/webmcp/demoState";

type DemoDispatch = (action: DemoStateAction) => void;

type StateReader = () => DemoState;

let nextToolRunId = 0;

function createToolRunId(toolName: WebMcpToolName): string {
  nextToolRunId += 1;
  return `${toolName}-${Date.now()}-${nextToolRunId}`;
}

type WorkspaceOverviewArgs = {
  projectId?: string;
  sessionLimit?: number;
};

type ListProjectsArgs = {
  limit?: number;
};

type ListSessionsArgs = {
  projectId?: string;
  status?: string;
  limit?: number;
};

type InspectSessionArgs = {
  sessionId: string;
};

type FocusSessionArgs = {
  sessionId: string;
  confirmed: boolean;
};

type StartAgentArgs = {
  projectId: string;
  prompt: string;
  confirmed: boolean;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
};

type SendFeedbackArgs = {
  sessionId: string;
  feedback: string;
  confirmed: boolean;
};

function nowIsoString(): string {
  return new Date().toISOString();
}

function inputError(tool: WebMcpToolName, error: string) {
  return {
    ok: false,
    tool,
    error,
  };
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function limitNumber(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
}

function summarizeSession(session: DemoSession) {
  return {
    contentTrust: "untrusted-synthetic-demo-data",
    id: session.id,
    projectId: session.projectId,
    projectName: session.projectName,
    title: session.title,
    status: session.status,
    agent: session.agent,
    branch: session.branch,
    summary: truncate(session.summary, 160),
    prompt: truncate(session.prompt, 220),
    lastFeedback: session.lastFeedback,
    updatedAt: session.updatedAt,
    syntheticLabel: session.syntheticLabel,
  };
}

function summarizeToolOutput(output: unknown): string {
  return truncate(JSON.stringify(output), 220);
}

function recordRun(
  dispatch: DemoDispatch,
  toolName: WebMcpToolName,
  summary: string,
  output: unknown,
  changedState: boolean,
): void {
  dispatch({
    type: "record-tool-run",
    run: {
      id: createToolRunId(toolName),
      toolName,
      changedState,
      summary,
      outputPreview: summarizeToolOutput(output),
      timestamp: nowIsoString(),
    },
  });
}

function missingSessionPayload(sessionId: string) {
  return {
    ok: false,
    mode: "synthetic-demo",
    error: `Synthetic session ${sessionId} was not found.`,
  };
}

function missingProjectPayload(projectId: string) {
  return {
    ok: false,
    mode: "synthetic-demo",
    error: `Synthetic project ${projectId} was not found.`,
  };
}

export function createDemoWebMcpTools(
  getState: StateReader,
  dispatch: DemoDispatch,
  requestHumanConfirmation: HumanConfirmationHandler = browserHumanConfirmation,
): WebMcpToolDefinition[] {
  const toolsByName: Record<WebMcpToolName, WebMcpToolDefinition> = {
    conductor_get_workspace_overview: createWebMcpTool<WorkspaceOverviewArgs>(
      "conductor_get_workspace_overview",
      (args) => executeToolSafely("conductor_get_workspace_overview", () => {
        const state = getState();
        const projectInput = readBoundedString(args?.projectId, "projectId", WEBMCP_INPUT_LIMITS.id);
        if (projectInput.error) {
          return inputError("conductor_get_workspace_overview", projectInput.error);
        }
        const limit = limitNumber(args?.sessionLimit, 4, 12);
        const sessions = state.sessions
          .filter((session) => !projectInput.value || session.projectId === projectInput.value)
          .slice(0, limit)
          .map(summarizeSession);
        const selectedSession = findDemoSession(state, state.selectedSessionId);
        const payload = {
          ok: true,
          mode: "synthetic-demo",
          disclaimer: "Synthetic workspace only. No real agent session has run.",
          workspace: {
            name: state.workspaceName,
            label: state.workspaceLabel,
            projectCount: state.projects.length,
            sessionCount: state.sessions.length,
            focusedSessionId: selectedSession?.id ?? null,
          },
          sessions,
        };
        recordRun(dispatch, "conductor_get_workspace_overview", "Read synthetic workspace overview.", payload, false);
        return payload;
      }, args),
    ),
    conductor_list_projects: createWebMcpTool<ListProjectsArgs>(
      "conductor_list_projects",
      (args) => executeToolSafely("conductor_list_projects", () => {
        const state = getState();
        const limit = limitNumber(args?.limit, state.projects.length, 25);
        const payload = {
          ok: true,
          mode: "synthetic-demo",
          projects: state.projects.slice(0, limit).map((project) => ({
            contentTrust: "untrusted-synthetic-demo-data",
            id: project.id,
            name: project.name,
            description: project.description,
            branch: project.branch,
            health: project.health,
            syntheticLabel: project.syntheticLabel,
          })),
        };
        recordRun(dispatch, "conductor_list_projects", "Listed synthetic projects.", payload, false);
        return payload;
      }, args),
    ),
    conductor_list_sessions: createWebMcpTool<ListSessionsArgs>(
      "conductor_list_sessions",
      (args) => executeToolSafely("conductor_list_sessions", () => {
        const state = getState();
        const projectInput = readBoundedString(args?.projectId, "projectId", WEBMCP_INPUT_LIMITS.id);
        const statusInput = readBoundedString(args?.status, "status", WEBMCP_INPUT_LIMITS.status);
        if (projectInput.error || statusInput.error) {
          return inputError("conductor_list_sessions", projectInput.error ?? statusInput.error ?? "Invalid input.");
        }
        const limit = limitNumber(args?.limit, 8, 12);
        const sessions = state.sessions
          .filter((session) => !projectInput.value || session.projectId === projectInput.value)
          .filter((session) => !statusInput.value || session.status === statusInput.value)
          .slice(0, limit)
          .map((session) => ({
            ...summarizeSession(session),
            diffFilesChanged: session.diffFiles.length,
          }));
        const payload = {
          ok: true,
          mode: "synthetic-demo",
          sessions,
        };
        recordRun(dispatch, "conductor_list_sessions", "Listed synthetic sessions.", payload, false);
        return payload;
      }, args),
    ),
    conductor_inspect_session: createWebMcpTool<InspectSessionArgs>(
      "conductor_inspect_session",
      (args) => executeToolSafely("conductor_inspect_session", () => {
        const sessionInput = readBoundedString(args?.sessionId, "sessionId", WEBMCP_INPUT_LIMITS.id);
        if (sessionInput.error) {
          return inputError("conductor_inspect_session", sessionInput.error);
        }
        const sessionId = sessionInput.value;
        if (!sessionId) {
          return {
            ok: false,
            tool: "conductor_inspect_session",
            error: "sessionId is required.",
          };
        }
        const state = getState();
        const session = findDemoSession(state, sessionId);
        if (!session) {
          const missing = missingSessionPayload(sessionId);
          recordRun(dispatch, "conductor_inspect_session", `Session ${sessionId} was not found.`, missing, false);
          return missing;
        }
        const payload = {
          ok: true,
          mode: "synthetic-demo",
          disclaimer: "Session prompt and diff fields below are synthetic untrusted demo content.",
          session: summarizeSession(session),
          diff: {
            contentTrust: "untrusted-synthetic-demo-data",
            summary: session.diffSummary,
            fileCount: session.diffFiles.length,
            files: session.diffFiles.slice(0, 10),
          },
        };
        recordRun(dispatch, "conductor_inspect_session", `Inspected synthetic session ${session.id}.`, payload, false);
        return payload;
      }, args),
    ),
    conductor_focus_session: createWebMcpTool<FocusSessionArgs>(
      "conductor_focus_session",
      (args) => executeToolSafely("conductor_focus_session", async () => {
        const rejected = requireConfirmedMutation(
          args,
          "conductor_focus_session",
          "changing the visible synthetic session",
        );
        if (rejected) {
          const payload = JSON.parse(rejected) as unknown;
          recordRun(dispatch, "conductor_focus_session", "Rejected synthetic focus change without confirmation.", payload, false);
          return payload;
        }
        const sessionInput = readBoundedString(args?.sessionId, "sessionId", WEBMCP_INPUT_LIMITS.id);
        if (sessionInput.error) {
          return inputError("conductor_focus_session", sessionInput.error);
        }
        const sessionId = sessionInput.value;
        if (!sessionId) {
          return {
            ok: false,
            tool: "conductor_focus_session",
            error: "sessionId is required.",
          };
        }
        const state = getState();
        const session = findDemoSession(state, sessionId);
        if (!session) {
          const missing = missingSessionPayload(sessionId);
          recordRun(dispatch, "conductor_focus_session", `Session ${sessionId} was not found.`, missing, false);
          return missing;
        }
        const humanRejected = await requireHumanConfirmation(
          requestHumanConfirmation,
          "conductor_focus_session",
          "change the visible synthetic session",
        );
        if (humanRejected) {
          const payload = JSON.parse(humanRejected) as unknown;
          recordRun(dispatch, "conductor_focus_session", "Human approval was not granted for focus change.", payload, false);
          return payload;
        }
        const timestamp = nowIsoString();
        dispatch({ type: "focus-session", sessionId: session.id, timestamp });
        const payload = {
          ok: true,
          mode: "synthetic-demo",
          stateChanged: true,
          focusedSession: summarizeSession(session),
        };
        recordRun(dispatch, "conductor_focus_session", `Focused synthetic session ${session.id}.`, payload, true);
        return payload;
      }, args),
    ),
    conductor_start_agent: createWebMcpTool<StartAgentArgs>(
      "conductor_start_agent",
      (args) => executeToolSafely("conductor_start_agent", async () => {
        const rejected = requireConfirmedMutation(
          args,
          "conductor_start_agent",
          "creating a new Conductor session",
        );
        if (rejected) {
          const payload = JSON.parse(rejected) as unknown;
          recordRun(dispatch, "conductor_start_agent", "Rejected synthetic session creation without confirmation.", payload, false);
          return payload;
        }

        const projectInput = readBoundedString(args?.projectId, "projectId", WEBMCP_INPUT_LIMITS.id);
        const promptInput = readBoundedString(args?.prompt, "prompt", WEBMCP_INPUT_LIMITS.prompt);
        const agentInput = readBoundedString(args?.agent, "agent", WEBMCP_INPUT_LIMITS.agent);
        const modelInput = readBoundedString(args?.model, "model", WEBMCP_INPUT_LIMITS.model);
        const reasoningInput = readBoundedString(
          args?.reasoningEffort,
          "reasoningEffort",
          WEBMCP_INPUT_LIMITS.reasoningEffort,
        );
        const validationError = projectInput.error
          ?? promptInput.error
          ?? agentInput.error
          ?? modelInput.error
          ?? reasoningInput.error;
        if (validationError) {
          return inputError("conductor_start_agent", validationError);
        }
        const projectId = projectInput.value;
        const prompt = promptInput.value;
        if (!projectId || !prompt) {
          return {
            ok: false,
            tool: "conductor_start_agent",
            error: "projectId and prompt are required.",
          };
        }
        const state = getState();
        const project = findDemoProject(state, projectId);
        if (!project) {
          const missing = missingProjectPayload(projectId);
          recordRun(dispatch, "conductor_start_agent", `Project ${projectId} was not found.`, missing, false);
          return missing;
        }
        const humanRejected = await requireHumanConfirmation(
          requestHumanConfirmation,
          "conductor_start_agent",
          "create a synthetic session",
        );
        if (humanRejected) {
          const payload = JSON.parse(humanRejected) as unknown;
          recordRun(dispatch, "conductor_start_agent", "Human approval was not granted for session creation.", payload, false);
          return payload;
        }

        const timestamp = nowIsoString();
        dispatch({
          type: "start-agent",
          timestamp,
          projectId: project.id,
          prompt,
          agent: agentInput.value,
        });
        const nextState = demoStateReducer(state, {
          type: "start-agent",
          timestamp,
          projectId: project.id,
          prompt,
          agent: agentInput.value,
        });
        const session = findDemoSession(nextState, nextState.selectedSessionId);
        const payload = {
          ok: true,
          mode: "synthetic-demo",
          disclaimer: "Synthetic only. No real coding agent was launched.",
          stateChanged: true,
          session: session ? summarizeSession(session) : null,
        };
        recordRun(dispatch, "conductor_start_agent", `Queued synthetic session for ${project.id}.`, payload, true);
        return payload;
      }, args),
    ),
    conductor_send_feedback: createWebMcpTool<SendFeedbackArgs>(
      "conductor_send_feedback",
      (args) => executeToolSafely("conductor_send_feedback", async () => {
        const rejected = requireConfirmedMutation(
          args,
          "conductor_send_feedback",
          "sending session feedback",
        );
        if (rejected) {
          const payload = JSON.parse(rejected) as unknown;
          recordRun(dispatch, "conductor_send_feedback", "Rejected synthetic feedback without confirmation.", payload, false);
          return payload;
        }

        const sessionInput = readBoundedString(args?.sessionId, "sessionId", WEBMCP_INPUT_LIMITS.id);
        const feedbackInput = readBoundedString(args?.feedback, "feedback", WEBMCP_INPUT_LIMITS.feedback);
        if (sessionInput.error || feedbackInput.error) {
          return inputError(
            "conductor_send_feedback",
            sessionInput.error ?? feedbackInput.error ?? "Invalid input.",
          );
        }
        const sessionId = sessionInput.value;
        const feedback = feedbackInput.value;
        if (!sessionId || !feedback) {
          return {
            ok: false,
            tool: "conductor_send_feedback",
            error: "sessionId and feedback are required.",
          };
        }
        const state = getState();
        const session = findDemoSession(state, sessionId);
        if (!session) {
          const missing = missingSessionPayload(sessionId);
          recordRun(dispatch, "conductor_send_feedback", `Session ${sessionId} was not found.`, missing, false);
          return missing;
        }
        const humanRejected = await requireHumanConfirmation(
          requestHumanConfirmation,
          "conductor_send_feedback",
          "send synthetic session feedback",
        );
        if (humanRejected) {
          const payload = JSON.parse(humanRejected) as unknown;
          recordRun(dispatch, "conductor_send_feedback", "Human approval was not granted for feedback.", payload, false);
          return payload;
        }
        const timestamp = nowIsoString();
        dispatch({
          type: "send-feedback",
          timestamp,
          sessionId: session.id,
          feedback,
        });
        const nextState = demoStateReducer(state, {
          type: "send-feedback",
          timestamp,
          sessionId: session.id,
          feedback,
        });
        const updated = findDemoSession(nextState, session.id);
        const payload = {
          ok: true,
          mode: "synthetic-demo",
          disclaimer: "Synthetic only. This visible update stays in memory and resets on reload.",
          stateChanged: true,
          session: updated ? summarizeSession(updated) : summarizeSession(session),
        };
        recordRun(dispatch, "conductor_send_feedback", `Sent synthetic feedback to ${session.id}.`, payload, true);
        return payload;
      }, args),
    ),
  };

  return WEBMCP_TOOL_ORDER.map((toolName) => toolsByName[toolName]);
}
