"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Eye,
  FlaskConical,
  FolderGit2,
  ListFilter,
  MessagesSquare,
  Play,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PublicPageShell, PublicPanel, PublicSection } from "@/components/public/PublicPageShell";
import { cn } from "@/lib/cn";
import { WEBMCP_TOOL_ORDER, WEBMCP_TOOL_SPECS, type WebMcpToolName } from "@/lib/webmcpTools";
import { createDemoWebMcpTools } from "@/features/webmcp/demoTools";
import { createInitialDemoState, demoStateReducer, findDemoSession } from "@/features/webmcp/demoState";
import { useWebMcpToolRegistration } from "@/features/webmcp/useWebMcpToolRegistration";

type SamplePrompt = {
  id: string;
  label: string;
  prompt: string;
  toolName: WebMcpToolName;
  configure?: () => void;
};

function statusBadgeVariant(status: string): "default" | "success" | "warning" | "error" | "info" {
  if (status === "working" || status === "completed") return "success";
  if (status === "needs_input") return "warning";
  if (status === "review") return "error";
  return "info";
}

function compatibilityBadgeVariant(supported: boolean): "success" | "warning" {
  return supported ? "success" : "warning";
}

function readOnlyLabel(toolName: WebMcpToolName): string {
  return WEBMCP_TOOL_SPECS[toolName].annotations?.readOnlyHint ? "Read only" : "State change";
}

function formattedToolCount(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

export function WebMcpDemoPage() {
  const [state, dispatch] = useReducer(demoStateReducer, undefined, createInitialDemoState);
  const stateRef = useRef(state);
  const [activeToolName, setActiveToolName] = useState<WebMcpToolName>("conductor_get_workspace_overview");
  const [projectFilter, setProjectFilter] = useState("demo-web");
  const [sessionTarget, setSessionTarget] = useState(state.selectedSessionId);
  const [sessionStatusFilter, setSessionStatusFilter] = useState("");
  const [limitValue, setLimitValue] = useState("6");
  const [promptDraft, setPromptDraft] = useState(
    "Prepare a judge-facing walkthrough for the synthetic WebMCP demo and keep every change visible in the dashboard.",
  );
  const [feedbackDraft, setFeedbackDraft] = useState(
    "Keep the confirmation boundary explicit and mention that this page uses synthetic in-memory data only.",
  );
  const [confirmFocus, setConfirmFocus] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmFeedback, setConfirmFeedback] = useState(false);
  const [runningTool, setRunningTool] = useState<WebMcpToolName | null>(null);
  const [lastResult, setLastResult] = useState<string>("");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    setSessionTarget((current) => {
      if (state.sessions.some((session) => session.id === current)) {
        return current;
      }
      return state.selectedSessionId;
    });
    setProjectFilter((current) => {
      if (state.projects.some((project) => project.id === current)) {
        return current;
      }
      return state.projects[0]?.id ?? "";
    });
  }, [state.projects, state.selectedSessionId, state.sessions]);

  const tools = useMemo(
    () => createDemoWebMcpTools(() => stateRef.current, dispatch),
    [dispatch],
  );
  const toolsByName = useMemo(
    () => new Map(tools.map((tool) => [tool.name as WebMcpToolName, tool])),
    [tools],
  );
  const compatibility = useWebMcpToolRegistration(tools);
  const selectedSession = useMemo(
    () => findDemoSession(state, state.selectedSessionId),
    [state],
  );

  const runTool = async (toolName: WebMcpToolName, args: unknown) => {
    const tool = toolsByName.get(toolName);
    if (!tool) {
      return;
    }
    setRunningTool(toolName);
    try {
      const output = await tool.execute(args);
      setLastResult(output);
    } finally {
      setRunningTool(null);
    }
  };

  const activeSchema = WEBMCP_TOOL_SPECS[activeToolName].inputSchema;
  const activeTool = toolsByName.get(activeToolName) ?? null;

  const samplePrompts: SamplePrompt[] = [
    {
      id: "sample-1",
      label: "Overview",
      prompt: "Get the workspace overview and summarize which synthetic session is currently focused.",
      toolName: "conductor_get_workspace_overview",
      configure: () => {
        setActiveToolName("conductor_get_workspace_overview");
        setProjectFilter("demo-web");
        setLimitValue("6");
      },
    },
    {
      id: "sample-2",
      label: "Inspect",
      prompt: "Inspect `demo-session-198` and summarize the synthetic diff plus the approval boundary.",
      toolName: "conductor_inspect_session",
      configure: () => {
        setActiveToolName("conductor_inspect_session");
        setSessionTarget("demo-session-198");
      },
    },
    {
      id: "sample-3",
      label: "Focus",
      prompt: "Focus `demo-session-176` in the visible workspace and proceed only if `confirmed` is true.",
      toolName: "conductor_focus_session",
      configure: () => {
        setActiveToolName("conductor_focus_session");
        setSessionTarget("demo-session-176");
        setConfirmFocus(true);
      },
    },
    {
      id: "sample-4",
      label: "Start",
      prompt: "Start a new synthetic session for `demo-docs` and only proceed if `confirmed` is true.",
      toolName: "conductor_start_agent",
      configure: () => {
        setActiveToolName("conductor_start_agent");
        setProjectFilter("demo-docs");
        setPromptDraft("Draft a concise public walkthrough for the WebMCP challenge judges.");
        setConfirmStart(true);
      },
    },
  ];

  const buildArgsForActiveTool = (): unknown => {
    const limit = Number.parseInt(limitValue, 10);
    if (activeToolName === "conductor_get_workspace_overview") {
      return { projectId: projectFilter || undefined, sessionLimit: Number.isFinite(limit) ? limit : 6 };
    }
    if (activeToolName === "conductor_list_projects") {
      return { limit: Number.isFinite(limit) ? limit : 6 };
    }
    if (activeToolName === "conductor_list_sessions") {
      return {
        projectId: projectFilter || undefined,
        status: sessionStatusFilter || undefined,
        limit: Number.isFinite(limit) ? limit : 6,
      };
    }
    if (activeToolName === "conductor_inspect_session") {
      return { sessionId: sessionTarget };
    }
    if (activeToolName === "conductor_focus_session") {
      return { sessionId: sessionTarget, confirmed: confirmFocus };
    }
    if (activeToolName === "conductor_start_agent") {
      return {
        projectId: projectFilter,
        prompt: promptDraft,
        confirmed: confirmStart,
        agent: "codex",
      };
    }
    return {
      sessionId: sessionTarget,
      feedback: feedbackDraft,
      confirmed: confirmFeedback,
    };
  };

  return (
    <PublicPageShell>
      <div className="space-y-8">
        <PublicSection
          title="Browser-native WebMCP for Conductor"
          description="This public route is a backend-free synthetic workspace built for the challenge branch. It registers browser-native tools when `document.modelContext.registerTool` is available, stays fully usable without WebMCP, and makes every visible state change explicit."
        >
          <div className="flex flex-wrap gap-2">
            <Badge variant="info">Public route</Badge>
            <Badge variant="info">Synthetic data</Badge>
            <Badge variant={compatibilityBadgeVariant(compatibility.supported)}>
              {compatibility.supported ? "WebMCP available" : "WebMCP unavailable"}
            </Badge>
            <Badge variant="outline">{formattedToolCount(tools.length)}</Badge>
          </div>
        </PublicSection>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.95fr)]">
          <div className="min-w-0 space-y-6">
            <PublicPanel className="overflow-hidden">
              <div className="border-b border-[var(--border-soft)] px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">Compatibility</p>
                    <h2 className="text-lg font-semibold tracking-[-0.02em] text-[var(--text-strong)]">
                      Cross-browser status
                    </h2>
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <Badge variant={compatibilityBadgeVariant(compatibility.supported)}>
                      {compatibility.supported ? "Registered" : "Fallback mode"}
                    </Badge>
                    <Badge variant="outline">{compatibility.toolRegistrationAvailable ? "registerTool found" : "registerTool missing"}</Badge>
                  </div>
                </div>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-muted)]">
                  {compatibility.reason}
                </p>
              </div>

              <div className="grid gap-px bg-[var(--border-soft)] md:grid-cols-3">
                <div className="bg-[var(--bg-panel)] px-5 py-4">
                  <div className="flex items-center gap-2 text-[var(--text-muted)]">
                    <ShieldCheck className="h-4 w-4" />
                    <span className="text-[12px] uppercase tracking-[0.18em]">Guardrails</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[var(--text-normal)]">
                    No terminal keystrokes, no secrets, no arbitrary paths, no arbitrary URLs, and no destructive actions.
                  </p>
                </div>
                <div className="bg-[var(--bg-panel)] px-5 py-4">
                  <div className="flex items-center gap-2 text-[var(--text-muted)]">
                    <FlaskConical className="h-4 w-4" />
                    <span className="text-[12px] uppercase tracking-[0.18em]">Synthetic scope</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[var(--text-normal)]">
                    Every project, session, prompt, and diff on this page is synthetic and resets on reload.
                  </p>
                </div>
                <div className="bg-[var(--bg-panel)] px-5 py-4">
                  <div className="flex items-center gap-2 text-[var(--text-muted)]">
                    <CheckCircle2 className="h-4 w-4" />
                    <span className="text-[12px] uppercase tracking-[0.18em]">Approval boundary</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[var(--text-normal)]">
                    Mutating tools require `confirmed: true`, even in the synthetic demo.
                  </p>
                </div>
              </div>
            </PublicPanel>

            <PublicPanel className="overflow-hidden">
              <div className="border-b border-[var(--border-soft)] px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">Workspace</p>
                    <h2 className="text-lg font-semibold tracking-[-0.02em] text-[var(--text-strong)]">
                      {state.workspaceName}
                    </h2>
                  </div>
                  <Badge variant="outline" className="max-w-full whitespace-normal text-left">{state.workspaceLabel}</Badge>
                </div>
              </div>

              <div className="grid gap-6 p-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <div className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-normal)]">
                      <FolderGit2 className="h-4 w-4 text-[var(--vk-orange)]" />
                      Synthetic projects
                    </div>
                    <div className="grid gap-3">
                      {state.projects.map((project) => (
                        <div
                          key={project.id}
                          className={cn(
                            "rounded-[var(--radius-md)] border px-4 py-3",
                            project.id === projectFilter
                              ? "border-[var(--vk-orange)] bg-[color:color-mix(in_srgb,var(--vk-orange)_12%,var(--bg-panel))]"
                              : "border-[var(--border-soft)] bg-[var(--bg-shell)]",
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-[var(--text-strong)]">{project.name}</span>
                                <Badge variant="outline">{project.syntheticLabel}</Badge>
                              </div>
                              <p className="text-sm leading-6 text-[var(--text-muted)]">{project.description}</p>
                            </div>
                            <Badge variant={project.health === "attention" ? "warning" : project.health === "working" ? "success" : "info"}>
                              {project.health}
                            </Badge>
                          </div>
                          <p className="mt-3 text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">
                            Branch: <span className="normal-case tracking-normal text-[var(--text-normal)]">{project.branch}</span>
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-normal)]">
                      <Clock3 className="h-4 w-4 text-[var(--vk-orange)]" />
                      Recent tool activity
                    </div>
                    <div className="grid gap-2">
                      {state.toolRuns.length === 0 ? (
                        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--border-soft)] px-4 py-4 text-sm leading-6 text-[var(--text-muted)]">
                          Run a tool from the inspector or through WebMCP to log visible activity here.
                        </div>
                      ) : (
                        state.toolRuns.map((run) => (
                          <div key={run.id} className="rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-4 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-medium text-[var(--text-strong)]">{run.toolName}</p>
                                <p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">{run.summary}</p>
                              </div>
                              <Badge variant={run.changedState ? "warning" : "outline"}>
                                {run.changedState ? "State changed" : "Read"}
                              </Badge>
                            </div>
                            <p className="mt-2 text-xs leading-5 text-[var(--text-faint)]">{run.outputPreview}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-normal)]">
                      <MessagesSquare className="h-4 w-4 text-[var(--vk-orange)]" />
                      Synthetic sessions
                    </div>
                    <div className="grid gap-2">
                      {state.sessions.map((session) => {
                        const active = session.id === state.selectedSessionId;
                        return (
                          <button
                            key={session.id}
                            type="button"
                            onClick={() => dispatch({
                              type: "focus-session",
                              sessionId: session.id,
                              timestamp: new Date().toISOString(),
                            })}
                            className={cn(
                              "w-full rounded-[var(--radius-md)] border px-4 py-3 text-left transition-colors",
                              active
                                ? "border-[var(--vk-orange)] bg-[color:color-mix(in_srgb,var(--vk-orange)_10%,var(--bg-panel))]"
                                : "border-[var(--border-soft)] bg-[var(--bg-shell)] hover:bg-[var(--bg-panel)]",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="truncate font-medium text-[var(--text-strong)]">{session.title}</span>
                                  <Badge variant="outline">{session.syntheticLabel}</Badge>
                                </div>
                                <p className="mt-1 text-sm text-[var(--text-muted)]">
                                  {session.id} · {session.projectId} · {session.agent}
                                </p>
                              </div>
                              <Badge variant={statusBadgeVariant(session.status)}>{session.status}</Badge>
                            </div>
                            <p className="mt-3 text-sm leading-6 text-[var(--text-normal)]">{session.summary}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {selectedSession ? (
                    <div className="rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)]">
                      <div className="border-b border-[var(--border-soft)] px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Eye className="h-4 w-4 text-[var(--vk-orange)]" />
                          <span className="font-medium text-[var(--text-strong)]">Focused synthetic session</span>
                          <Badge variant={statusBadgeVariant(selectedSession.status)}>{selectedSession.status}</Badge>
                        </div>
                      </div>
                      <div className="space-y-4 px-4 py-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-panel)] px-3 py-3">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-faint)]">Prompt</p>
                            <p className="mt-2 text-sm leading-6 text-[var(--text-normal)]">{selectedSession.prompt}</p>
                          </div>
                          <div className="rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-panel)] px-3 py-3">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-faint)]">Diff summary</p>
                            <p className="mt-2 text-sm leading-6 text-[var(--text-normal)]">{selectedSession.diffSummary}</p>
                          </div>
                        </div>

                        <div className="rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-panel)] px-3 py-3">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-faint)]">Synthetic diff files</p>
                          <div className="mt-3 space-y-2">
                            {selectedSession.diffFiles.length === 0 ? (
                              <p className="text-sm leading-6 text-[var(--text-muted)]">No diff yet for this synthetic queued session.</p>
                            ) : (
                              selectedSession.diffFiles.map((file) => (
                                <div key={`${selectedSession.id}-${file.path}`} className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border-soft)] px-3 py-2">
                                  <div className="min-w-0">
                                    <p className="truncate font-mono text-[12px] text-[var(--text-strong)]">{file.path}</p>
                                    <p className="text-xs text-[var(--text-faint)]">{file.status}</p>
                                  </div>
                                  <p className="shrink-0 text-xs text-[var(--text-muted)]">
                                    +{file.additions} / -{file.deletions}
                                  </p>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        {selectedSession.lastFeedback ? (
                          <div className="rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-panel)] px-3 py-3">
                            <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-faint)]">Last feedback</p>
                            <p className="mt-2 text-sm leading-6 text-[var(--text-normal)]">{selectedSession.lastFeedback}</p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </PublicPanel>

            <PublicPanel className="overflow-hidden">
              <div className="border-b border-[var(--border-soft)] px-5 py-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-[var(--vk-orange)]" />
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-[var(--text-strong)]">
                    Timeline
                  </h2>
                </div>
              </div>
              <div className="space-y-3 px-5 py-4">
                {state.timeline.map((event) => (
                  <div key={event.id} className="rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-4 py-3">
                    <p className="text-sm leading-6 text-[var(--text-normal)]">{event.label}</p>
                    <p className="mt-1 text-xs text-[var(--text-faint)]">{event.timestamp}</p>
                  </div>
                ))}
              </div>
            </PublicPanel>
          </div>

          <div className="min-w-0 space-y-6">
            <PublicPanel className="overflow-hidden">
              <div className="border-b border-[var(--border-soft)] px-5 py-4">
                <div className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-[var(--vk-orange)]" />
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-[var(--text-strong)]">Tool inspector</h2>
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                  Every tool below uses the same browser-native registration metadata as the real dashboard bridge.
                </p>
              </div>

              <div className="grid gap-px bg-[var(--border-soft)]">
                <div className="bg-[var(--bg-panel)] p-3">
                  <div className="grid gap-2">
                    {WEBMCP_TOOL_ORDER.map((toolName) => {
                      const spec = WEBMCP_TOOL_SPECS[toolName];
                      const active = toolName === activeToolName;
                      return (
                        <button
                          key={toolName}
                          type="button"
                          onClick={() => setActiveToolName(toolName)}
                          className={cn(
                            "w-full rounded-[var(--radius-md)] border px-3 py-3 text-left transition-colors",
                            active
                              ? "border-[var(--vk-orange)] bg-[color:color-mix(in_srgb,var(--vk-orange)_10%,var(--bg-shell))]"
                              : "border-[var(--border-soft)] bg-[var(--bg-shell)] hover:bg-[var(--bg-panel-2)]",
                          )}
                        >
                          <p className="break-words font-mono text-[12px] font-medium leading-5 text-[var(--text-strong)]">{toolName}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Badge variant={spec.annotations?.readOnlyHint ? "outline" : "warning"}>
                              {readOnlyLabel(toolName)}
                            </Badge>
                            {spec.annotations?.untrustedContentHint ? (
                              <Badge variant="info">Untrusted content</Badge>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-4 bg-[var(--bg-panel)] p-5">
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={WEBMCP_TOOL_SPECS[activeToolName].annotations?.readOnlyHint ? "outline" : "warning"}>
                        {readOnlyLabel(activeToolName)}
                      </Badge>
                      {WEBMCP_TOOL_SPECS[activeToolName].annotations?.untrustedContentHint ? (
                        <Badge variant="info">Returns untrusted content</Badge>
                      ) : null}
                    </div>
                    <h3 className="break-words font-mono text-[13px] font-semibold leading-5 text-[var(--text-strong)]">{activeToolName}</h3>
                    <p className="text-sm leading-6 text-[var(--text-muted)]">
                      {WEBMCP_TOOL_SPECS[activeToolName].description}
                    </p>
                  </div>

                  <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-4 py-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-normal)]">
                      <ListFilter className="h-4 w-4 text-[var(--vk-orange)]" />
                      Manual invocation
                    </div>

                    {(activeToolName === "conductor_get_workspace_overview"
                      || activeToolName === "conductor_list_sessions"
                      || activeToolName === "conductor_start_agent") ? (
                      <label className="block space-y-1.5">
                        <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">Project</span>
                        <select
                          value={projectFilter}
                          onChange={(event) => setProjectFilter(event.target.value)}
                          className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                        >
                          {state.projects.map((project) => (
                            <option key={project.id} value={project.id}>{project.id}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {(activeToolName === "conductor_get_workspace_overview"
                      || activeToolName === "conductor_list_projects"
                      || activeToolName === "conductor_list_sessions") ? (
                      <label className="block space-y-1.5">
                        <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">Limit</span>
                        <input
                          value={limitValue}
                          onChange={(event) => setLimitValue(event.target.value)}
                          className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          inputMode="numeric"
                        />
                      </label>
                    ) : null}

                    {activeToolName === "conductor_list_sessions" ? (
                      <label className="block space-y-1.5">
                        <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">Status</span>
                        <input
                          value={sessionStatusFilter}
                          onChange={(event) => setSessionStatusFilter(event.target.value)}
                          placeholder="working, needs_input, review..."
                          className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                        />
                      </label>
                    ) : null}

                    {(activeToolName === "conductor_inspect_session"
                      || activeToolName === "conductor_focus_session"
                      || activeToolName === "conductor_send_feedback") ? (
                      <label className="block space-y-1.5">
                        <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">Session</span>
                        <select
                          value={sessionTarget}
                          onChange={(event) => setSessionTarget(event.target.value)}
                          className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                        >
                          {state.sessions.map((session) => (
                            <option key={session.id} value={session.id}>{session.id}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {activeToolName === "conductor_focus_session" ? (
                      <label className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border-soft)] px-3 py-2 text-sm text-[var(--text-normal)]">
                        <input
                          type="checkbox"
                          checked={confirmFocus}
                          onChange={(event) => setConfirmFocus(event.target.checked)}
                        />
                        confirmed: true
                      </label>
                    ) : null}

                    {activeToolName === "conductor_start_agent" ? (
                      <>
                        <label className="block space-y-1.5">
                          <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">Prompt</span>
                          <textarea
                            value={promptDraft}
                            onChange={(event) => setPromptDraft(event.target.value)}
                            className="min-h-28 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-2 text-[14px] leading-6 text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                        </label>
                        <label className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border-soft)] px-3 py-2 text-sm text-[var(--text-normal)]">
                          <input
                            type="checkbox"
                            checked={confirmStart}
                            onChange={(event) => setConfirmStart(event.target.checked)}
                          />
                          confirmed: true
                        </label>
                      </>
                    ) : null}

                    {activeToolName === "conductor_send_feedback" ? (
                      <>
                        <label className="block space-y-1.5">
                          <span className="text-xs uppercase tracking-[0.18em] text-[var(--text-faint)]">Feedback</span>
                          <textarea
                            value={feedbackDraft}
                            onChange={(event) => setFeedbackDraft(event.target.value)}
                            className="min-h-28 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-2 text-[14px] leading-6 text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                        </label>
                        <label className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--border-soft)] px-3 py-2 text-sm text-[var(--text-normal)]">
                          <input
                            type="checkbox"
                            checked={confirmFeedback}
                            onChange={(event) => setConfirmFeedback(event.target.checked)}
                          />
                          confirmed: true
                        </label>
                      </>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="primary"
                        size="md"
                        onClick={() => void runTool(activeToolName, buildArgsForActiveTool())}
                        disabled={!activeTool || runningTool !== null}
                      >
                        {runningTool === activeToolName ? (
                          <>
                            <Bot className="h-4 w-4 animate-pulse" />
                            Running
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4" />
                            Run tool
                          </>
                        )}
                      </Button>
                      {!compatibility.supported ? (
                        <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-soft)] px-3 py-2 text-sm text-[var(--text-muted)]">
                          <CircleAlert className="h-4 w-4" />
                          Manual fallback stays usable without WebMCP.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-4 py-4">
                    <p className="text-sm font-medium text-[var(--text-normal)]">Input schema</p>
                    <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--bg-panel)] p-3 text-[12px] leading-6 text-[var(--text-muted)]">
                      {JSON.stringify(activeSchema, null, 2)}
                    </pre>
                  </div>

                  <div className="space-y-2 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-4 py-4">
                    <p className="text-sm font-medium text-[var(--text-normal)]">Last JSON result</p>
                    <pre className="max-h-[320px] overflow-auto rounded-[var(--radius-sm)] bg-[var(--bg-panel)] p-3 text-[12px] leading-6 text-[var(--text-muted)]">
                      {lastResult || "Run a tool to inspect its JSON string output."}
                    </pre>
                  </div>
                </div>
              </div>
            </PublicPanel>

            <PublicPanel className="overflow-hidden">
              <div className="border-b border-[var(--border-soft)] px-5 py-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-[var(--vk-orange)]" />
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-[var(--text-strong)]">Sample prompts</h2>
                </div>
              </div>
              <div className="space-y-3 px-5 py-4">
                {samplePrompts.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => entry.configure?.()}
                    className="w-full rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-panel)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-[var(--text-strong)]">{entry.label}</span>
                      <Badge variant="outline">{entry.toolName}</Badge>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{entry.prompt}</p>
                  </button>
                ))}
              </div>
            </PublicPanel>
          </div>
        </div>
      </div>
    </PublicPageShell>
  );
}
