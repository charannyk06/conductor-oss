"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import type { DashboardSession } from "@/lib/types";
import { useSessions } from "@/hooks/useSessions";
import { useConfig } from "@/hooks/useConfig";
import { useAgents } from "@/hooks/useAgents";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { SessionDetail } from "@/components/sessions/SessionDetail";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { WorkspaceSidebarPanel } from "@/components/layout/WorkspaceSidebarPanel";
import { WorkspaceKanban } from "@/components/board/WorkspaceKanban";

const EXECUTOR_ORDER = [
  "codex",
  "gemini",
  "qwen-code",
  "droid",
  "claude-code",
  "amp",
  "opencode",
  "github-copilot",
  "cursor-cli",
  "ccr",
];

const EXECUTOR_LABELS: Record<string, string> = {
  codex: "Codex",
  gemini: "Gemini",
  "qwen-code": "Qwen Code",
  droid: "Droid",
  "claude-code": "Claude Code",
  amp: "Amp",
  opencode: "Opencode",
  "github-copilot": "Copilot",
  "cursor-cli": "Cursor Agent",
  ccr: "CCR",
};

function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function getAgentLabel(value: string): string {
  const normalized = normalizeAgentName(value);
  if (EXECUTOR_LABELS[normalized]) return EXECUTOR_LABELS[normalized];
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

type NewWorkspacePayload = {
  mode: "git" | "local";
  projectId?: string;
  agent: string;
  defaultBranch: string;
  useWorktree?: boolean;
  gitUrl?: string;
  path?: string;
  initializeGit?: boolean;
};

export default function Home() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { sessions, error: sessionsError, refresh: refreshSessions } = useSessions(selectedProjectId);
  const { projects, error: configError, refresh: refreshConfig } = useConfig();
  const { agents } = useAgents();

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [prompt, setPrompt] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("qwen-code");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWorkspaceError, setNewWorkspaceError] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<"chat" | "board">("chat");

  const dashboardSessions = sessions as unknown as DashboardSession[];
  const workspaceError = createError ?? configError ?? sessionsError;

  useEffect(() => {
    if (projects.length === 0) {
      if (selectedProjectId !== null) setSelectedProjectId(null);
      return;
    }

    if (!selectedProjectId || !projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? null);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (!dashboardSessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(null);
    }
  }, [dashboardSessions, selectedSessionId]);

  const selectedSession = useMemo(
    () => dashboardSessions.find((s) => s.id === selectedSessionId) ?? null,
    [dashboardSessions, selectedSessionId],
  );

  const agentOptions = useMemo(() => {
    const safeAgents = Array.isArray(agents) ? agents : [];
    const opts = new Set<string>();
    for (const project of projects) {
      if (project.agent) opts.add(project.agent);
    }
    for (const agent of safeAgents) {
      if (agent.name) opts.add(agent.name);
    }
    if (opts.size === 0) {
      ["qwen-code", "claude-code", "codex"].forEach((name) => opts.add(name));
    }
    return [...opts];
  }, [agents, projects]);

  useEffect(() => {
    const fromProject = projects.find((p) => p.id === selectedProjectId)?.agent;
    if (fromProject) {
      setSelectedAgent(fromProject);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!agentOptions.includes(selectedAgent) && agentOptions.length > 0) {
      setSelectedAgent(agentOptions[0] ?? "qwen-code");
    }
  }, [agentOptions, selectedAgent]);

  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  async function handleCreateSession() {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;

    const projectId = selectedProjectId ?? projects[0]?.id;
    if (!projectId) {
      setCreateError("No project is configured in conductor.yaml");
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          prompt: trimmedPrompt,
          agent: selectedAgent,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | { session?: DashboardSession; error?: string }
        | null;

      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to create workspace: ${res.status}`);
      }

      if (!data?.session?.id) {
        throw new Error("Session created but response is missing session id");
      }

      setPrompt("");
      setWorkspaceView("chat");
      setSidebarOpen(true);
      await refreshSessions();
      setSelectedSessionId(data.session.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateWorkspace(payload: NewWorkspacePayload) {
    setCreatingWorkspace(true);
    setNewWorkspaceError(null);

    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json().catch(() => null)) as
        | { project?: { id?: string }; error?: string }
        | null;

      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to add workspace: ${res.status}`);
      }

      const createdProjectId = data?.project?.id;
      if (!createdProjectId) {
        throw new Error("Workspace created but response is missing project id");
      }

      await refreshConfig();
      setSelectedProjectId(createdProjectId);
      setSelectedSessionId(null);
      setPrompt("");
      setSidebarOpen(true);
      setNewWorkspaceOpen(false);
    } catch (err) {
      setNewWorkspaceError(err instanceof Error ? err.message : "Failed to add workspace");
    } finally {
      setCreatingWorkspace(false);
    }
  }

  return (
    <>
      <AppShell
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        sidebar={
          <WorkspaceSidebarPanel
            orgLabel="conductor-oss"
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={(projectId) => {
              setSelectedProjectId(projectId);
              setSelectedSessionId(null);
            }}
            sessions={dashboardSessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={(id) => setSelectedSessionId(id)}
            onCreateWorkspace={() => {
              setNewWorkspaceError(null);
              setNewWorkspaceOpen(true);
              setSidebarOpen(true);
            }}
          />
        }
      >
        <TopBar
          session={selectedSession}
          fallbackTitle={selectedProjectId ?? (workspaceView === "board" ? "Board" : "Create Workspace")}
        />

        <div className="min-h-0 flex-1 overflow-hidden">
          {selectedSessionId ? (
            <SessionDetail sessionId={selectedSessionId} />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b border-[var(--vk-border)] px-3 py-2">
                <div className="inline-flex rounded-[3px] border border-[var(--vk-border)] p-px">
                  <button
                    type="button"
                    onClick={() => setWorkspaceView("chat")}
                    className={`min-h-[28px] rounded-[2px] px-3 text-[13px] ${
                      workspaceView === "chat"
                        ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                        : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                    }`}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => setWorkspaceView("board")}
                    className={`min-h-[28px] rounded-[2px] px-3 text-[13px] ${
                      workspaceView === "board"
                        ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                        : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                    }`}
                  >
                    Board
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-hidden">
                {workspaceView === "board" ? (
                  <WorkspaceKanban
                    projectId={selectedProjectId}
                    defaultAgent={selectedAgent}
                    agentOptions={agentOptions}
                  />
                ) : (
                  <CreateWorkspacePanel
                    prompt={prompt}
                    setPrompt={setPrompt}
                    selectedAgent={selectedAgent}
                    setSelectedAgent={setSelectedAgent}
                    agentOptions={agentOptions}
                    projectLabel={selectedProjectId ? `${selectedProjectId} · main` : "No project selected"}
                    creating={creating}
                    error={workspaceError}
                    onCreate={handleCreateSession}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </AppShell>

      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onClose={() => {
          if (creatingWorkspace) return;
          setNewWorkspaceOpen(false);
        }}
        onCreate={handleCreateWorkspace}
        creating={creatingWorkspace}
        error={newWorkspaceError}
        defaultAgent={selectedAgent}
        agentOptions={agentOptions}
      />
    </>
  );
}

function NewWorkspaceDialog({
  open,
  onClose,
  onCreate,
  creating,
  error,
  defaultAgent,
  agentOptions,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: NewWorkspacePayload) => Promise<void>;
  creating: boolean;
  error: string | null;
  defaultAgent: string;
  agentOptions: string[];
}) {
  const [mode, setMode] = useState<"git" | "local">("git");
  const [projectId, setProjectId] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [path, setPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [agent, setAgent] = useState(defaultAgent);
  const [useWorktree, setUseWorktree] = useState(true);
  const [initializeGit, setInitializeGit] = useState(true);

  useEffect(() => {
    if (!open) return;
    setMode("git");
    setProjectId("");
    setGitUrl("");
    setPath("");
    setDefaultBranch("main");
    setInitializeGit(true);
    setUseWorktree(true);
    setAgent(defaultAgent);
  }, [defaultAgent, open]);

  const orderedAgentOptions = useMemo(() => {
    const opts = [...new Set(agentOptions)];
    if (opts.length === 0) {
      opts.push(defaultAgent || "qwen-code");
    }

    const rankMap = new Map(EXECUTOR_ORDER.map((name, index) => [name, index]));
    return opts.sort((left, right) => {
      const leftRank = rankMap.get(normalizeAgentName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankMap.get(normalizeAgentName(right)) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return getAgentLabel(left).localeCompare(getAgentLabel(right));
    });
  }, [agentOptions, defaultAgent]);

  useEffect(() => {
    if (!orderedAgentOptions.includes(agent)) {
      setAgent(orderedAgentOptions[0] ?? "qwen-code");
    }
  }, [agent, orderedAgentOptions]);

  if (!open) return null;

  const canSubmit = mode === "git"
    ? gitUrl.trim().length > 0 && defaultBranch.trim().length > 0
    : path.trim().length > 0 && defaultBranch.trim().length > 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || creating) return;

    const payload: NewWorkspacePayload =
      mode === "git"
        ? {
            mode,
            projectId: projectId.trim() || undefined,
            agent,
            defaultBranch: defaultBranch.trim(),
            useWorktree,
            gitUrl: gitUrl.trim(),
            path: path.trim() || undefined,
          }
        : {
            mode,
            projectId: projectId.trim() || undefined,
            agent,
            defaultBranch: defaultBranch.trim(),
            useWorktree,
            path: path.trim(),
            initializeGit,
          };

    await onCreate(payload);
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 px-3"
      onClick={() => {
        if (creating) return;
        onClose();
      }}
      role="presentation"
    >
      <form
        onSubmit={handleSubmit}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[620px] rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <header className="flex items-center border-b border-[var(--vk-border)] px-4 py-3">
          <div>
            <h2 className="text-[18px] leading-[22px] text-[var(--vk-text-strong)]">Add Workspace</h2>
            <p className="pt-1 text-[12px] text-[var(--vk-text-muted)]">
              Add a git repository or register a local folder for session spawning.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            aria-label="Close dialog"
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-4 py-4">
          <div className="inline-flex rounded-[4px] border border-[var(--vk-border)] p-1">
            <button
              type="button"
              onClick={() => setMode("git")}
              className={`rounded-[3px] px-3 py-1.5 text-[13px] ${
                mode === "git"
                  ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                  : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
              }`}
            >
              Git Repository
            </button>
            <button
              type="button"
              onClick={() => setMode("local")}
              className={`rounded-[3px] px-3 py-1.5 text-[13px] ${
                mode === "local"
                  ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                  : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
              }`}
            >
              Local Folder
            </button>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Project ID (optional)</span>
            <input
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder="auto-derived from repo/folder"
              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
            />
          </label>

          {mode === "git" ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Git URL</span>
                <input
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/org/repo.git"
                  className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">
                  Local Path (optional, clone target)
                </span>
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="~/workspace/projects/repo-name"
                  className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Local Path</span>
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="~/workspace/projects/my-local-repo"
                  className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                />
              </label>
              <label className="flex items-center gap-2 text-[13px] text-[var(--vk-text-normal)]">
                <input
                  type="checkbox"
                  checked={initializeGit}
                  onChange={(event) => setInitializeGit(event.target.checked)}
                  className="h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
                />
                <span>Initialize git if this folder is non-git</span>
              </label>
            </>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Default Branch</span>
              <input
                value={defaultBranch}
                onChange={(event) => setDefaultBranch(event.target.value)}
                placeholder="main"
                className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Agent</span>
              <select
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
                className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
              >
                {orderedAgentOptions.map((item) => (
                  <option key={item} value={item} className="bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)]">
                    {getAgentLabel(item)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex items-start gap-2 rounded-[4px] border border-[var(--vk-border)] px-2 py-2 text-[13px] text-[var(--vk-text-normal)]">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(event) => setUseWorktree(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
            />
            <span>
              Use worktree isolation
              <span className="block text-[11px] text-[var(--vk-text-muted)]">
                If unchecked, sessions run directly on the selected branch in the local repo.
              </span>
            </span>
          </label>

          {error && <p className="text-[12px] text-[var(--vk-red)]">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || creating}
            className="inline-flex h-9 items-center rounded-[4px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
          >
            {creating ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Adding...
              </>
            ) : "Add Workspace"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function CreateWorkspacePanel({
  prompt,
  setPrompt,
  selectedAgent,
  setSelectedAgent,
  agentOptions,
  projectLabel,
  creating,
  error,
  onCreate,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  selectedAgent: string;
  setSelectedAgent: (value: string) => void;
  agentOptions: string[];
  projectLabel: string;
  creating: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  const orderedAgentOptions = useMemo(() => {
    const rankMap = new Map(EXECUTOR_ORDER.map((name, index) => [name, index]));
    return [...agentOptions].sort((left, right) => {
      const leftRank = rankMap.get(normalizeAgentName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankMap.get(normalizeAgentName(right)) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return getAgentLabel(left).localeCompare(getAgentLabel(right));
    });
  }, [agentOptions]);

  const selectedAgentLabel = getAgentLabel(selectedAgent);

  return (
    <section className="flex h-full min-h-0 items-center justify-center overflow-auto px-3 py-6">
      <div className="w-full max-w-[768px]">
        <h1 className="pb-4 text-center text-[36px] font-medium leading-[40px] tracking-[-0.9px] text-[var(--vk-text-strong)]">
          What would you like to work on?
        </h1>

        <div className="rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-px">
          <div className="flex items-center border-b border-[var(--vk-border)] px-2 py-2">
            <AgentTileIcon seed={{ label: selectedAgent }} className="h-8 w-8 border-none bg-transparent" />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="ml-2 inline-flex h-[31px] items-center rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-[9px] py-[5px] text-[14px] text-[var(--vk-text-normal)] outline-none hover:bg-[var(--vk-bg-hover)] data-[state=open]:bg-[var(--vk-bg-hover)]"
                  aria-label="Select agent"
                >
                  <span className="pr-1">{selectedAgentLabel}</span>
                  <ChevronDown className="h-3 w-3 text-[var(--vk-text-muted)]" />
                </button>
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={6}
                  className="z-50 min-w-[255px] rounded-[5px] border border-[var(--vk-border)] bg-[color:#2a2a2a] p-2 shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
                >
                  <p className="px-2 pb-1 text-[14px] font-semibold leading-[21px] text-[var(--vk-text-muted)]">
                    Agents
                  </p>

                  {orderedAgentOptions.map((agent) => {
                    const isSelected = agent === selectedAgent;
                    return (
                      <DropdownMenu.Item
                        key={agent}
                        onSelect={() => setSelectedAgent(agent)}
                        className="flex h-[40px] cursor-default items-center gap-2 rounded-[3px] px-2 text-[14px] leading-[21px] text-[var(--vk-text-strong)] outline-none hover:bg-[var(--vk-bg-hover)] focus:bg-[var(--vk-bg-hover)]"
                      >
                        <AgentTileIcon seed={{ label: agent }} className="h-6 w-6 border-none bg-transparent" />
                        <span>{getAgentLabel(agent)}</span>
                        <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                          {isSelected ? <Check className="h-4 w-4" /> : null}
                        </span>
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>

          <div className="px-2 py-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the task..."
              rows={2}
              className="min-h-[48px] w-full resize-none bg-transparent text-[16px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
            />
          </div>

          <div className="flex items-center justify-between border-t border-[var(--vk-border)] px-2 py-2">
            <div className="flex min-w-0 items-center text-[14px] text-[var(--vk-text-normal)]">
              <span className="truncate">{projectLabel}</span>
            </div>

            <button
              type="button"
              onClick={onCreate}
              disabled={creating || prompt.trim().length === 0}
              className="inline-flex min-h-[29px] items-center justify-center rounded-[3px] bg-[var(--vk-bg-active)] px-2 text-[16px] text-[var(--vk-text-normal)] transition-colors hover:bg-[var(--vk-bg-hover)] disabled:opacity-45"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
            </button>
          </div>
        </div>

        {error && <p className="pt-2 text-[12px] text-[var(--vk-red)]">{error}</p>}
      </div>
    </section>
  );
}
