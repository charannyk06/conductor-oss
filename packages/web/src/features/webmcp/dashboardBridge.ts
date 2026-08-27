"use client";

import { useEffect, useMemo, useRef } from "react";
import type { DashboardSession } from "@/lib/types";
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
import { withBridgeQuery } from "@/lib/bridgeQuery";
import { decodeBridgeSessionId } from "@/lib/bridgeSessionIds";
import { useWebMcpToolRegistration } from "@/features/webmcp/useWebMcpToolRegistration";

type NavigateDashboardUpdates = {
  projectId?: string | null;
  sessionId?: string | null;
  workspaceView?: "direct" | "board" | "notes" | null;
  tab?: "overview" | "dispatcher" | "diff" | "preview" | "terminal" | null;
  bridgeId?: string | null;
};

type NavigateDashboard = (
  updates: NavigateDashboardUpdates,
  mode?: "push" | "replace",
) => void;

type UseDashboardWebMcpBridgeOptions = {
  bridgeId: string | null;
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  navigateDashboard: NavigateDashboard;
  refreshSessions: () => Promise<void>;
};

type DashboardProjectPayload = {
  id?: unknown;
  name?: unknown;
  default_executor?: unknown;
  defaultExecutor?: unknown;
  max_sessions?: unknown;
  maxSessions?: unknown;
};

type DashboardDiffFilePayload = {
  path?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
};

type DashboardDiffPayload = {
  hasDiff?: unknown;
  generatedAt?: unknown;
  source?: unknown;
  truncated?: unknown;
  branch?: unknown;
  defaultBranch?: unknown;
  files?: unknown;
  sections?: unknown;
};

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

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function inputError(tool: WebMcpToolName, error: string) {
  return {
    ok: false,
    tool,
    error,
  };
}

function truncate(text: string | null | undefined, maxLength: number): string | null {
  const value = readString(text);
  if (!value) {
    return null;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function bridgeScopeLabel(bridgeId: string | null | undefined): string {
  return readString(bridgeId) ?? "local";
}

function resolveSessionBridgeId(sessionId: string, fallbackBridgeId: string | null): string | null {
  return decodeBridgeSessionId(sessionId)?.bridgeId ?? fallbackBridgeId;
}

function readSessionsPayload(payload: unknown): DashboardSession[] {
  if (Array.isArray(payload)) {
    return payload as DashboardSession[];
  }
  const record = readObject(payload);
  return Array.isArray(record?.sessions) ? record.sessions as DashboardSession[] : [];
}

function readSessionPayload(payload: unknown): DashboardSession {
  const record = readObject(payload);
  const candidate = readObject(record?.session) ?? record;
  const id = readString(candidate?.id);
  const projectId = readString(candidate?.projectId);
  if (!candidate || !id || !projectId) {
    throw new Error("Session response is missing a valid session id or project id.");
  }
  return {
    ...candidate,
    id,
    projectId,
  } as DashboardSession;
}

function summarizeProject(raw: DashboardProjectPayload) {
  return {
    contentTrust: "untrusted-workspace-data",
    id: readString(raw.id) ?? "unknown-project",
    name: readString(raw.name) ?? "Unnamed project",
    defaultExecutor: readString(raw.defaultExecutor) ?? readString(raw.default_executor),
    maxSessions: readNumber(raw.maxSessions) ?? readNumber(raw.max_sessions),
  };
}

function summarizeSession(session: DashboardSession) {
  return {
    contentTrust: "untrusted-workspace-data",
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    agent: readString(session.agent) ?? null,
    branch: readString(session.branch) ?? null,
    summary: truncate(session.summary, 220),
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    taskId: readString(session.metadata?.taskId),
    sessionKind: readString(session.metadata?.sessionKind),
  };
}

function summarizeDiff(diff: DashboardDiffPayload) {
  const files = Array.isArray(diff.files) ? diff.files : [];
  return {
    contentTrust: "untrusted-repository-data",
    hasDiff: diff.hasDiff === true,
    source: readString(diff.source),
    generatedAt: readString(diff.generatedAt),
    branch: readString(diff.branch),
    defaultBranch: readString(diff.defaultBranch),
    truncated: diff.truncated === true,
    fileCount: files.length,
    files: files.slice(0, 12).map((entry) => {
      const file = readObject(entry) as DashboardDiffFilePayload | null;
      return {
        path: readString(file?.path),
        status: readString(file?.status),
        additions: readNumber(file?.additions),
        deletions: readNumber(file?.deletions),
      };
    }),
    sectionCounts: (() => {
      const sections = readObject(diff.sections);
      if (!sections) {
        return null;
      }
      const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
      return {
        againstBase: count(sections.againstBase),
        staged: count(sections.staged),
        unstaged: count(sections.unstaged),
        untracked: count(sections.untracked),
      };
    })(),
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  return await response.json().catch(() => null);
}

async function fetchDashboardJson(
  path: string,
  bridgeId: string | null | undefined,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(withBridgeQuery(path, bridgeId), init);
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    const body = readObject(payload);
    throw new Error(
      readString(body?.error)
      ?? readString(body?.reason)
      ?? `Request failed: ${response.status}`,
    );
  }
  return payload;
}

export function createDashboardWebMcpTools(options: {
  getBridgeId: () => string | null;
  getSelection: () => { selectedProjectId: string | null; selectedSessionId: string | null };
  navigateDashboard: NavigateDashboard;
  refreshSessions: () => Promise<void>;
  requestHumanConfirmation?: HumanConfirmationHandler;
}): WebMcpToolDefinition[] {
  const requestHumanConfirmation = options.requestHumanConfirmation ?? browserHumanConfirmation;
  const tools = {
    conductor_get_workspace_overview: createWebMcpTool<WorkspaceOverviewArgs>(
      "conductor_get_workspace_overview",
      (args, execution) => executeToolSafely("conductor_get_workspace_overview", async () => {
        const bridgeId = options.getBridgeId();
        const projectInput = readBoundedString(args?.projectId, "projectId", WEBMCP_INPUT_LIMITS.id);
        if (projectInput.error) {
          return inputError("conductor_get_workspace_overview", projectInput.error);
        }
        const [projectsPayload, sessionsPayload] = await Promise.all([
          fetchDashboardJson("/api/projects", bridgeId, { signal: execution?.signal }),
          fetchDashboardJson("/api/sessions", bridgeId, { signal: execution?.signal }),
        ]);
        const projectId = projectInput.value;
        const sessionLimit = normalizeLimit(args?.sessionLimit, 6, 12);
        const projects = Array.isArray(projectsPayload) ? projectsPayload : [];
        const sessions = readSessionsPayload(sessionsPayload);
        const filteredSessions = sessions
          .filter((session) => !projectId || session.projectId === projectId)
          .slice(0, sessionLimit)
          .map(summarizeSession);
        const selection = options.getSelection();
        return {
          ok: true,
          mode: "dashboard",
          bridgeScope: bridgeScopeLabel(bridgeId),
          focusedSessionId: selection.selectedSessionId,
          selectedProjectId: selection.selectedProjectId,
          projects: projects.slice(0, 12).map((entry) => summarizeProject(readObject(entry) as DashboardProjectPayload ?? {})),
          sessions: filteredSessions,
        };
      }, args),
    ),
    conductor_list_projects: createWebMcpTool<ListProjectsArgs>(
      "conductor_list_projects",
      (args, execution) => executeToolSafely("conductor_list_projects", async () => {
        const bridgeId = options.getBridgeId();
        const payload = await fetchDashboardJson("/api/projects", bridgeId, { signal: execution?.signal });
        const limit = normalizeLimit(args?.limit, 12, 25);
        const projects = Array.isArray(payload) ? payload : [];
        return {
          ok: true,
          mode: "dashboard",
          bridgeScope: bridgeScopeLabel(bridgeId),
          projects: projects
            .slice(0, limit)
            .map((entry) => summarizeProject(readObject(entry) as DashboardProjectPayload ?? {})),
        };
      }, args),
    ),
    conductor_list_sessions: createWebMcpTool<ListSessionsArgs>(
      "conductor_list_sessions",
      (args, execution) => executeToolSafely("conductor_list_sessions", async () => {
        const bridgeId = options.getBridgeId();
        const limit = normalizeLimit(args?.limit, 10, 12);
        const projectInput = readBoundedString(args?.projectId, "projectId", WEBMCP_INPUT_LIMITS.id);
        const statusInput = readBoundedString(args?.status, "status", WEBMCP_INPUT_LIMITS.status);
        if (projectInput.error || statusInput.error) {
          return inputError("conductor_list_sessions", projectInput.error ?? statusInput.error ?? "Invalid input.");
        }
        const payload = await fetchDashboardJson("/api/sessions", bridgeId, { signal: execution?.signal });
        const projectId = projectInput.value;
        const status = statusInput.value;
        const sessions = readSessionsPayload(payload);
        return {
          ok: true,
          mode: "dashboard",
          bridgeScope: bridgeScopeLabel(bridgeId),
          sessions: sessions
            .filter((session) => !projectId || session.projectId === projectId)
            .filter((session) => !status || session.status === status)
            .slice(0, limit)
            .map(summarizeSession),
        };
      }, args),
    ),
    conductor_inspect_session: createWebMcpTool<InspectSessionArgs>(
      "conductor_inspect_session",
      (args, execution) => executeToolSafely("conductor_inspect_session", async () => {
        const bridgeId = options.getBridgeId();
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
        const scopedBridgeId = resolveSessionBridgeId(sessionId, bridgeId);
        const [sessionPayload, diffPayload] = await Promise.all([
          fetchDashboardJson(`/api/sessions/${encodeURIComponent(sessionId)}`, scopedBridgeId, { signal: execution?.signal }),
          fetchDashboardJson(`/api/sessions/${encodeURIComponent(sessionId)}/diff`, scopedBridgeId, { signal: execution?.signal }),
        ]);
        return {
          ok: true,
          mode: "dashboard",
          bridgeScope: bridgeScopeLabel(scopedBridgeId),
          disclaimer: "Session summaries and diff paths are untrusted repository content.",
          session: summarizeSession(readSessionPayload(sessionPayload)),
          diff: summarizeDiff((readObject(diffPayload) ?? {}) as DashboardDiffPayload),
        };
      }, args),
    ),
    conductor_focus_session: createWebMcpTool<FocusSessionArgs>(
      "conductor_focus_session",
      (args, execution) => executeToolSafely("conductor_focus_session", async () => {
        const rejected = requireConfirmedMutation(
          args,
          "conductor_focus_session",
          "changing the visible dashboard session",
        );
        if (rejected) {
          return JSON.parse(rejected) as unknown;
        }
        const bridgeId = options.getBridgeId();
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
        const humanRejected = await requireHumanConfirmation(
          requestHumanConfirmation,
          "conductor_focus_session",
          "change the visible dashboard session",
        );
        if (humanRejected) {
          return JSON.parse(humanRejected) as unknown;
        }
        const scopedBridgeId = resolveSessionBridgeId(sessionId, bridgeId);
        const session = readSessionPayload(await fetchDashboardJson(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          scopedBridgeId,
          { signal: execution?.signal },
        ));
        options.navigateDashboard(
          {
            projectId: session.projectId,
            sessionId: session.id,
            tab: null,
            bridgeId: scopedBridgeId,
          },
          "push",
        );
        return {
          ok: true,
          mode: "dashboard",
          bridgeScope: bridgeScopeLabel(scopedBridgeId),
          stateChanged: true,
          session: summarizeSession(session),
        };
      }, args),
    ),
    conductor_start_agent: createWebMcpTool<StartAgentArgs>(
      "conductor_start_agent",
      (args, execution) => executeToolSafely("conductor_start_agent", async () => {
        const rejected = requireConfirmedMutation(
          args,
          "conductor_start_agent",
          "creating a real dashboard session",
        );
        if (rejected) {
          return JSON.parse(rejected) as unknown;
        }
        const bridgeId = options.getBridgeId();
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
        const humanRejected = await requireHumanConfirmation(
          requestHumanConfirmation,
          "conductor_start_agent",
          "create a real dashboard session",
        );
        if (humanRejected) {
          return JSON.parse(humanRejected) as unknown;
        }
        const payload = await fetchDashboardJson("/api/sessions", bridgeId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: execution?.signal,
          body: JSON.stringify({
            projectId,
            prompt,
            ...(agentInput.value ? { agent: agentInput.value } : {}),
            ...(modelInput.value ? { model: modelInput.value } : {}),
            ...(reasoningInput.value ? { reasoningEffort: reasoningInput.value } : {}),
          }),
        });
        const created = readSessionPayload(payload);
        await options.refreshSessions();
        options.navigateDashboard(
          {
            projectId: created.projectId,
            sessionId: created.id,
            tab: null,
            bridgeId,
          },
          "push",
        );
        return {
          ok: true,
          mode: "dashboard",
          bridgeScope: bridgeScopeLabel(bridgeId),
          stateChanged: true,
          session: summarizeSession(created),
        };
      }, args),
    ),
    conductor_send_feedback: createWebMcpTool<SendFeedbackArgs>(
      "conductor_send_feedback",
      (args, execution) => executeToolSafely("conductor_send_feedback", async () => {
        const rejected = requireConfirmedMutation(
          args,
          "conductor_send_feedback",
          "sending real session feedback",
        );
        if (rejected) {
          return JSON.parse(rejected) as unknown;
        }
        const bridgeId = options.getBridgeId();
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
        const humanRejected = await requireHumanConfirmation(
          requestHumanConfirmation,
          "conductor_send_feedback",
          "send real session feedback",
        );
        if (humanRejected) {
          return JSON.parse(humanRejected) as unknown;
        }
        const scopedBridgeId = resolveSessionBridgeId(sessionId, bridgeId);
        await fetchDashboardJson(`/api/sessions/${encodeURIComponent(sessionId)}/feedback`, scopedBridgeId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: execution?.signal,
          body: JSON.stringify({ message: feedback }),
        });
        await options.refreshSessions();
        const session = readSessionPayload(await fetchDashboardJson(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          scopedBridgeId,
          { signal: execution?.signal },
        ));
        options.navigateDashboard(
          {
            projectId: session.projectId,
            sessionId: session.id,
            tab: null,
            bridgeId: scopedBridgeId,
          },
          "push",
        );
        return {
          ok: true,
          mode: "dashboard",
          bridgeScope: bridgeScopeLabel(scopedBridgeId),
          stateChanged: true,
          session: summarizeSession(session),
        };
      }, args),
    ),
  } as const;

  return WEBMCP_TOOL_ORDER.map((toolName) => tools[toolName]);
}

export function useDashboardWebMcpBridge({
  bridgeId,
  selectedSessionId,
  selectedProjectId,
  navigateDashboard,
  refreshSessions,
}: UseDashboardWebMcpBridgeOptions): void {
  const bridgeIdRef = useRef<string | null>(bridgeId);
  const selectionRef = useRef({
    selectedProjectId,
    selectedSessionId,
  });
  const navigateRef = useRef(navigateDashboard);
  const refreshSessionsRef = useRef(refreshSessions);

  useEffect(() => {
    bridgeIdRef.current = bridgeId;
  }, [bridgeId]);

  useEffect(() => {
    selectionRef.current = {
      selectedProjectId,
      selectedSessionId,
    };
  }, [selectedProjectId, selectedSessionId]);

  useEffect(() => {
    navigateRef.current = navigateDashboard;
  }, [navigateDashboard]);

  useEffect(() => {
    refreshSessionsRef.current = refreshSessions;
  }, [refreshSessions]);

  const tools = useMemo(
    () => createDashboardWebMcpTools({
      getBridgeId: () => bridgeIdRef.current,
      getSelection: () => selectionRef.current,
      navigateDashboard: (updates, mode) => navigateRef.current(updates, mode),
      refreshSessions: () => refreshSessionsRef.current(),
    }),
    [],
  );

  useWebMcpToolRegistration(tools);
}
