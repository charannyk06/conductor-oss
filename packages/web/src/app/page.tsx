"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { IconType } from "react-icons";
import { SiNotion, SiObsidian } from "react-icons/si";
import { VscVscode } from "react-icons/vsc";
import {
  Bot,
  BookText,
  Building2,
  Check,
  ChevronDown,
  FolderOpen,
  FolderGit2,
  FolderKanban,
  Github,
  Loader2,
  PlugZap,
  RefreshCcw,
  Search,
  SlidersHorizontal,
  Settings2,
  type LucideIcon,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
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

type GitHubRepo = {
  name: string;
  fullName: string;
  httpsUrl: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
};

type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
};

type PreferencesPayload = {
  onboardingAcknowledged: boolean;
  codingAgent: string;
  ide: string;
  markdownEditor: string;
  notifications: {
    soundEnabled: boolean;
    soundFile: string | null;
  };
};

type RepositoryPathHealth = {
  exists: boolean;
  isGitRepository: boolean;
  suggestedPath: string | null;
};

type RepositorySettingsPayload = {
  id: string;
  displayName: string;
  repo: string;
  path: string;
  defaultWorkingDirectory: string;
  defaultBranch: string;
  devServerScript: string;
  setupScript: string;
  runSetupInParallel: boolean;
  cleanupScript: string;
  archiveScript: string;
  copyFiles: string;
  pathHealth: RepositoryPathHealth;
};

type PreferencesDialogMode = "onboarding" | "settings";
type SettingsTabId =
  | "general"
  | "repositories"
  | "organization"
  | "projects"
  | "agents"
  | "mcp"
  | "preferences";

const SETTINGS_TABS: Array<{
  id: SettingsTabId;
  label: string;
  icon: LucideIcon;
  implemented: boolean;
}> = [
  { id: "general", label: "General", icon: Settings2, implemented: false },
  { id: "repositories", label: "Repositories", icon: FolderGit2, implemented: true },
  { id: "organization", label: "Organization Settings", icon: Building2, implemented: false },
  { id: "projects", label: "Projects", icon: FolderKanban, implemented: false },
  { id: "agents", label: "Agents", icon: Bot, implemented: false },
  { id: "mcp", label: "MCP Servers", icon: PlugZap, implemented: false },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal, implemented: true },
];

const IDE_OPTIONS = [
  { id: "vscode", label: "VS Code" },
  { id: "vscode-insiders", label: "VS Code Insiders" },
  { id: "cursor", label: "Cursor" },
  { id: "windsurf", label: "Windsurf" },
  { id: "intellij-idea", label: "IntelliJ IDEA" },
  { id: "zed", label: "Zed" },
  { id: "xcode", label: "Xcode" },
  { id: "antigravity", label: "Antigravity" },
  { id: "custom", label: "Custom" },
];

const MARKDOWN_EDITOR_OPTIONS = [
  { id: "obsidian", label: "Obsidian" },
  { id: "vscode", label: "VS Code" },
  { id: "notion", label: "Notion" },
  { id: "typora", label: "Typora" },
  { id: "logseq", label: "Logseq" },
  { id: "custom", label: "Custom" },
];

const NOTIFICATION_SOUND_OPTIONS = [
  { id: "abstract-sound-1", label: "Abstract Sound 1" },
  { id: "abstract-sound-2", label: "Abstract Sound 2" },
  { id: "abstract-sound-3", label: "Abstract Sound 3" },
  { id: "abstract-sound-4", label: "Abstract Sound 4" },
  { id: "cow-mooing", label: "Cow Mooing" },
  { id: "phone-vibration", label: "Phone Vibration" },
  { id: "rooster", label: "Rooster" },
];

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function normalizePreferences(value: unknown, fallbackAgent: string): PreferencesPayload {
  const payload = toObject(value);
  const notifications = toObject(payload["notifications"]);
  const soundFileRaw = notifications["soundFile"];
  const codingAgent = typeof payload["codingAgent"] === "string" && payload["codingAgent"].trim().length > 0
    ? payload["codingAgent"].trim()
    : fallbackAgent;
  const ide = typeof payload["ide"] === "string" && payload["ide"].trim().length > 0
    ? payload["ide"].trim()
    : "vscode";
  const markdownEditor = typeof payload["markdownEditor"] === "string" && payload["markdownEditor"].trim().length > 0
    ? payload["markdownEditor"].trim()
    : "obsidian";

  return {
    onboardingAcknowledged: payload["onboardingAcknowledged"] === true,
    codingAgent,
    ide,
    markdownEditor,
    notifications: {
      soundEnabled: notifications["soundEnabled"] !== false,
      soundFile: soundFileRaw === null
        ? null
        : typeof soundFileRaw === "string" && soundFileRaw.trim().length > 0
          ? soundFileRaw.trim()
          : "abstract-sound-4",
    },
  };
}

const MARKDOWN_EDITOR_ICON_CLASS = "block h-4 w-4 shrink-0";
const CODE_EDITOR_ICON_CLASS = "block h-4 w-4 shrink-0 object-contain";

type CodeEditorIconSpec =
  | { kind: "icon"; icon: IconType; className: string }
  | { kind: "image"; imageSrc: string; className: string };

const CODE_EDITOR_ICON_MAP: Record<string, CodeEditorIconSpec> = {
  vscode: { kind: "image", imageSrc: "/icons/ide/vscode-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  "vscode-insiders": { kind: "image", imageSrc: "/icons/ide/vscode-insiders.svg", className: CODE_EDITOR_ICON_CLASS },
  cursor: { kind: "image", imageSrc: "/icons/ide/cursor-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  windsurf: { kind: "image", imageSrc: "/icons/ide/windsurf-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  "intellij-idea": { kind: "image", imageSrc: "/icons/ide/intellij.svg", className: CODE_EDITOR_ICON_CLASS },
  zed: { kind: "image", imageSrc: "/icons/ide/zed-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  xcode: { kind: "image", imageSrc: "/icons/ide/xcode.svg", className: CODE_EDITOR_ICON_CLASS },
  antigravity: { kind: "image", imageSrc: "/icons/ide/antigravity-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  custom: { kind: "icon", icon: Settings2, className: `${CODE_EDITOR_ICON_CLASS} text-[var(--vk-text-muted)]` },
};

function CodeEditorIcon({ editorId, label }: { editorId: string; label: string }) {
  const iconSpec = CODE_EDITOR_ICON_MAP[editorId];
  if (!iconSpec) {
    return <Settings2 className={`${CODE_EDITOR_ICON_CLASS} text-[var(--vk-text-muted)]`} />;
  }
  if (iconSpec.kind === "image") {
    return <img src={iconSpec.imageSrc} alt={`${label} logo`} className={iconSpec.className} />;
  }
  const Icon = iconSpec.icon;
  return <Icon className={iconSpec.className} />;
}

type MarkdownEditorIconSpec =
  | { kind: "icon"; icon: IconType; className: string }
  | { kind: "image"; imageSrc: string; className: string };

const MARKDOWN_EDITOR_ICON_MAP: Record<string, MarkdownEditorIconSpec> = {
  obsidian: { kind: "icon", icon: SiObsidian, className: `${MARKDOWN_EDITOR_ICON_CLASS} text-[#8b5cf6]` },
  vscode: { kind: "icon", icon: VscVscode, className: `${MARKDOWN_EDITOR_ICON_CLASS} text-[#22a3f5]` },
  notion: { kind: "icon", icon: SiNotion, className: `${MARKDOWN_EDITOR_ICON_CLASS} text-white` },
  logseq: { kind: "image", imageSrc: "/icons/editors/logseq.svg", className: `${MARKDOWN_EDITOR_ICON_CLASS} object-contain` },
  typora: {
    kind: "image",
    imageSrc: "/icons/editors/typora-32.png",
    className: `${MARKDOWN_EDITOR_ICON_CLASS} rounded-[3px] bg-white/90 p-[1px] object-contain`,
  },
  custom: { kind: "icon", icon: Settings2, className: `${MARKDOWN_EDITOR_ICON_CLASS} text-[var(--vk-text-muted)]` },
};

function MarkdownEditorIcon({ editorId }: { editorId: string }) {
  const iconSpec = MARKDOWN_EDITOR_ICON_MAP[editorId];
  if (!iconSpec) {
    return <BookText className={`${MARKDOWN_EDITOR_ICON_CLASS} text-[var(--vk-text-muted)]`} />;
  }
  if (iconSpec.kind === "image") {
    return <img src={iconSpec.imageSrc} alt="" className={iconSpec.className} />;
  }
  const Icon = iconSpec.icon;
  return <Icon className={iconSpec.className} />;
}

export default function Home() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { sessions, error: sessionsError, refresh: refreshSessions } = useSessions(selectedProjectId);
  const { projects, error: configError, refresh: refreshConfig } = useConfig();
  const { agents } = useAgents();

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [prompt, setPrompt] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWorkspaceError, setNewWorkspaceError] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<"chat" | "board">("chat");
  const [preferences, setPreferences] = useState<PreferencesPayload | null>(null);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [preferencesDialogOpen, setPreferencesDialogOpen] = useState(false);

  const dashboardSessions = sessions as unknown as DashboardSession[];
  const workspaceError = createError ?? configError ?? sessionsError ?? preferencesError;

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
    let cancelled = false;
    async function loadPreferences() {
      setPreferencesLoading(true);
      try {
        const res = await fetch("/api/preferences");
        const data = (await res.json().catch(() => null)) as
          | { preferences?: unknown; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(data?.error ?? `Failed to load preferences: ${res.status}`);
        }
        if (cancelled) return;
        const normalized = normalizePreferences(data?.preferences, "qwen-code");
        setPreferences(normalized);
        setPreferencesError(null);
      } catch (err) {
        if (cancelled) return;
        setPreferences(normalizePreferences(null, "qwen-code"));
        setPreferencesError(err instanceof Error ? err.message : "Failed to load preferences");
      } finally {
        if (!cancelled) {
          setPreferencesLoading(false);
        }
      }
    }

    void loadPreferences();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!preferences) return;
    if (!selectedAgent) {
      setSelectedAgent(preferences.codingAgent);
    }
  }, [preferences, selectedAgent]);

  useEffect(() => {
    if (preferencesLoading) return;
    if (!preferences) return;
    if (!preferences.onboardingAcknowledged) {
      setPreferencesDialogOpen(true);
    }
  }, [preferences, preferencesLoading]);

  useEffect(() => {
    if (selectedAgent) return;
    const fromProject = projects.find((p) => p.id === selectedProjectId)?.agent;
    if (fromProject) {
      setSelectedAgent(fromProject);
    }
  }, [projects, selectedAgent, selectedProjectId]);

  useEffect(() => {
    if (agentOptions.length === 0) return;
    if (!selectedAgent || !agentOptions.includes(selectedAgent)) {
      setSelectedAgent(agentOptions[0] ?? "qwen-code");
    }
  }, [agentOptions, selectedAgent]);

  async function handleSavePreferences(next: PreferencesPayload) {
    setPreferencesSaving(true);
    setPreferencesError(null);
    try {
      const res = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = (await res.json().catch(() => null)) as
        | { preferences?: unknown; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to save preferences: ${res.status}`);
      }
      const normalized = normalizePreferences(data?.preferences, next.codingAgent || "qwen-code");
      setPreferences(normalized);
      setSelectedAgent(normalized.codingAgent);
      setPreferencesDialogOpen(false);
    } catch (err) {
      setPreferencesError(err instanceof Error ? err.message : "Failed to save preferences");
      throw err;
    } finally {
      setPreferencesSaving(false);
    }
  }

  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  const openWorkspaceDialog = () => {
    setNewWorkspaceError(null);
    setNewWorkspaceOpen(true);
    setSidebarOpen(true);
  };

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
          agent: selectedAgent || "qwen-code",
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

  const onboardingRequired = !preferencesLoading && !!preferences && !preferences.onboardingAcknowledged;
  const resolvedPreferences = preferences ?? normalizePreferences(null, selectedAgent || "qwen-code");

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
              openWorkspaceDialog();
            }}
          />
        }
      >
        <TopBar
          session={selectedSession}
          fallbackTitle={selectedProjectId ?? (workspaceView === "board" ? "Board" : "Create Workspace")}
          onOpenPreferences={() => setPreferencesDialogOpen(true)}
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
                    defaultAgent={selectedAgent || resolvedPreferences.codingAgent || "qwen-code"}
                    agentOptions={agentOptions}
                  />
                ) : (
                  <CreateWorkspacePanel
                    prompt={prompt}
                    setPrompt={setPrompt}
                    selectedAgent={selectedAgent || resolvedPreferences.codingAgent || "qwen-code"}
                    setSelectedAgent={setSelectedAgent}
                    agentOptions={agentOptions}
                    projectLabel={selectedProjectId ?? "No project selected"}
                    hasProject={Boolean(selectedProjectId)}
                    creating={creating}
                    error={workspaceError}
                    onOpenAddWorkspace={openWorkspaceDialog}
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
        defaultAgent={selectedAgent || resolvedPreferences.codingAgent || "qwen-code"}
        agentOptions={agentOptions}
      />

      <SettingsDialog
        open={preferencesDialogOpen}
        mode={onboardingRequired ? "onboarding" : "settings"}
        creating={preferencesSaving}
        error={preferencesError}
        current={resolvedPreferences}
        agentOptions={agentOptions}
        onRepositoriesChanged={refreshConfig}
        onClose={() => {
          if (preferencesSaving || onboardingRequired) return;
          setPreferencesDialogOpen(false);
          setPreferencesError(null);
        }}
        onSave={handleSavePreferences}
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
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [githubReposLoading, setGithubReposLoading] = useState(false);
  const [githubReposError, setGithubReposError] = useState<string | null>(null);
  const [githubRepoSearch, setGithubRepoSearch] = useState("");
  const [selectedGithubRepo, setSelectedGithubRepo] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerTarget, setFolderPickerTarget] = useState<"clone" | "local">("local");
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);

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
    setGithubRepos([]);
    setGithubReposError(null);
    setGithubRepoSearch("");
    setSelectedGithubRepo("");
    setBranchOptions([]);
    setBranchesError(null);
    setBranchesLoading(false);
    setFolderPickerOpen(false);
    setFolderPickerTarget("local");
  }, [defaultAgent, open]);

  useEffect(() => {
    if (!open) return;
    if (mode !== "local") return;
    if (path.trim().length > 0) return;
    setFolderPickerTarget("local");
    setFolderPickerOpen(true);
  }, [mode, open, path]);

  const filteredGitHubRepos = useMemo(() => {
    if (githubRepoSearch.trim().length === 0) return githubRepos;
    const query = githubRepoSearch.trim().toLowerCase();
    return githubRepos.filter((repo) => {
      return repo.fullName.toLowerCase().includes(query)
        || repo.name.toLowerCase().includes(query)
        || repo.defaultBranch.toLowerCase().includes(query);
    });
  }, [githubRepoSearch, githubRepos]);

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

  const handleFetchGitHubRepos = async () => {
    setGithubReposLoading(true);
    setGithubReposError(null);
    try {
      const query = githubRepoSearch.trim();
      const queryParam = query.length > 0 ? `?q=${encodeURIComponent(query)}` : "";
      const res = await fetch(`/api/github/repos${queryParam}`);
      const data = (await res.json().catch(() => null)) as
        | { repos?: GitHubRepo[]; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to load GitHub repositories (${res.status})`);
      }
      setGithubRepos(Array.isArray(data?.repos) ? data.repos : []);
    } catch (err) {
      setGithubRepos([]);
      setGithubReposError(
        err instanceof Error ? err.message : "Failed to load GitHub repositories",
      );
    } finally {
      setGithubReposLoading(false);
    }
  };

  const handleDetectBranches = async (
    sourceOverride?: { gitUrl?: string; path?: string },
  ) => {
    const effectiveGitUrl = sourceOverride?.gitUrl ?? (mode === "git" ? gitUrl.trim() : "");
    const effectivePath = sourceOverride?.path ?? (mode === "local" ? path.trim() : "");

    if (effectiveGitUrl.length === 0 && effectivePath.length === 0) {
      setBranchesError(
        mode === "git"
          ? "Enter a Git URL first."
          : "Select a local repository path first.",
      );
      return;
    }

    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const params = new URLSearchParams();
      if (effectiveGitUrl.length > 0) {
        params.set("gitUrl", effectiveGitUrl);
      }
      if (effectivePath.length > 0) {
        params.set("path", effectivePath);
      }

      const res = await fetch(`/api/workspaces/branches?${params.toString()}`);
      const data = (await res.json().catch(() => null)) as
        | { branches?: string[]; defaultBranch?: string | null; error?: string }
        | null;

      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to load branches (${res.status})`);
      }

      const branches = Array.isArray(data?.branches)
        ? data.branches.filter((branch) => typeof branch === "string" && branch.trim().length > 0)
        : [];
      setBranchOptions(branches);

      const suggestedDefault = typeof data?.defaultBranch === "string" && data.defaultBranch.trim().length > 0
        ? data.defaultBranch.trim()
        : branches[0] ?? null;

      if (suggestedDefault && (defaultBranch.trim().length === 0 || !branches.includes(defaultBranch))) {
        setDefaultBranch(suggestedDefault);
      }
    } catch (err) {
      setBranchOptions([]);
      setBranchesError(err instanceof Error ? err.message : "Failed to load branches");
    } finally {
      setBranchesLoading(false);
    }
  };

  const handleSelectGitHubRepo = async (httpsUrl: string) => {
    setSelectedGithubRepo(httpsUrl);
    const selected = githubRepos.find((repo) => repo.httpsUrl === httpsUrl);
    if (!selected) return;

    setGitUrl(selected.httpsUrl);
    setDefaultBranch(selected.defaultBranch || "main");
    if (projectId.trim().length === 0) {
      const suggestedProjectId = selected.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
      setProjectId(suggestedProjectId || projectId);
    }

    await handleDetectBranches({ gitUrl: selected.httpsUrl });
  };

  const openFolderPicker = (target: "clone" | "local") => {
    setFolderPickerTarget(target);
    setFolderPickerOpen(true);
  };

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
    <>
      <div
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 px-3"
        onClick={() => {
          if (creating || folderPickerOpen) return;
          onClose();
        }}
        role="presentation"
      >
        <form
          onSubmit={handleSubmit}
          onClick={(event) => event.stopPropagation()}
          className="w-full max-w-[760px] rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        >
          <header className="flex items-center border-b border-[var(--vk-border)] px-4 py-3">
            <div>
              <h2 className="text-[18px] leading-[22px] text-[var(--vk-text-strong)]">Add Workspace</h2>
              <p className="pt-1 text-[12px] text-[var(--vk-text-muted)]">
                Select a repository with a folder picker, then choose the target branch.
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
                <div className="rounded-[4px] border border-[var(--vk-border)] p-3">
                  <div className="flex items-center gap-2">
                    <Github className="h-4 w-4 text-[var(--vk-text-muted)]" />
                    <span className="text-[12px] font-medium text-[var(--vk-text-normal)]">GitHub Integration</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleFetchGitHubRepos}
                      disabled={githubReposLoading}
                      className="inline-flex h-8 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                    >
                      {githubReposLoading ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          Loading repos...
                        </>
                      ) : "Load My GitHub Repositories"}
                    </button>
                    <div className="relative min-w-[220px] flex-1">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--vk-text-muted)]" />
                      <input
                        value={githubRepoSearch}
                        onChange={(event) => setGithubRepoSearch(event.target.value)}
                        placeholder="Filter repos..."
                        className="h-8 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent pl-7 pr-2 text-[12px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                      />
                    </div>
                  </div>
                  {filteredGitHubRepos.length > 0 && (
                    <label className="mt-2 block">
                      <span className="mb-1 block text-[11px] text-[var(--vk-text-muted)]">Choose repository</span>
                      <select
                        value={selectedGithubRepo}
                        onChange={(event) => {
                          void handleSelectGitHubRepo(event.target.value);
                        }}
                        className="h-8 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[12px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                      >
                        <option value="">Select a GitHub repo...</option>
                        {filteredGitHubRepos.map((repo) => (
                          <option key={repo.httpsUrl} value={repo.httpsUrl}>
                            {repo.fullName} ({repo.defaultBranch})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {githubReposError && (
                    <p className="mt-2 text-[11px] text-[var(--vk-red)]">{githubReposError}</p>
                  )}
                </div>

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
                  <div className="flex items-center gap-2">
                    <input
                      value={path}
                      readOnly
                      onClick={() => openFolderPicker("clone")}
                      placeholder="Use Browse to choose a clone target folder"
                      className="h-9 w-full cursor-pointer rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                    />
                    <button
                      type="button"
                      onClick={() => openFolderPicker("clone")}
                      className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                      title="Browse folders"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </button>
                  </div>
                </label>
              </>
            ) : (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Local Path</span>
                  <div className="flex items-center gap-2">
                    <input
                      value={path}
                      readOnly
                      onClick={() => openFolderPicker("local")}
                      placeholder="Use Browse to select a repository folder"
                      className="h-9 w-full cursor-pointer rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                    />
                    <button
                      type="button"
                      onClick={() => openFolderPicker("local")}
                      className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                      title="Browse folders"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </button>
                  </div>
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
                <div className="flex items-center gap-2">
                  <input
                    value={defaultBranch}
                    onChange={(event) => setDefaultBranch(event.target.value)}
                    placeholder="main"
                    className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void handleDetectBranches();
                    }}
                    disabled={branchesLoading}
                    className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                    title="Detect branches"
                  >
                    {branchesLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCcw className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                {branchOptions.length > 0 && (
                  <select
                    value={defaultBranch}
                    onChange={(event) => setDefaultBranch(event.target.value)}
                    className="mt-2 h-8 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[12px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                  >
                    {branchOptions.map((branch) => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                  </select>
                )}
                {branchesError && (
                  <p className="mt-1 text-[11px] text-[var(--vk-red)]">{branchesError}</p>
                )}
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

      <FolderPickerDialog
        open={folderPickerOpen}
        initialPath={path}
        title={folderPickerTarget === "local" ? "Select Local Repository" : "Select Clone Target Folder"}
        description={folderPickerTarget === "local"
          ? "Choose the local repository folder."
          : "Choose where the git repository should be cloned."}
        onClose={() => setFolderPickerOpen(false)}
        onSelect={(selectedPath) => {
          setFolderPickerOpen(false);
          if (!selectedPath) return;
          setPath(selectedPath);
          if (mode === "local" || folderPickerTarget === "local") {
            void handleDetectBranches({ path: selectedPath });
          }
        }}
      />
    </>
  );
}

function FolderPickerDialog({
  open,
  initialPath,
  title,
  description,
  onClose,
  onSelect,
}: {
  open: boolean;
  initialPath?: string;
  title: string;
  description: string;
  onClose: () => void;
  onSelect: (path: string | null) => void;
}) {
  const [currentPath, setCurrentPath] = useState("");
  const [manualPath, setManualPath] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setManualPath(initialPath ?? "");
    const targetPath = initialPath && initialPath.trim().length > 0 ? initialPath.trim() : undefined;
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
    setLoading(true);
    setError(null);
    fetch(`/api/filesystem/directory${query}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | { currentPath?: string; entries?: DirectoryEntry[]; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(data?.error ?? `Failed to load directory (${res.status})`);
        }
        setCurrentPath(typeof data?.currentPath === "string" ? data.currentPath : "");
        setEntries(Array.isArray(data?.entries) ? data.entries : []);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load directory");
        setEntries([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [initialPath, open]);

  const filteredEntries = useMemo(() => {
    if (search.trim().length === 0) return entries;
    const query = search.trim().toLowerCase();
    return entries.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [entries, search]);

  const loadDirectory = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = path && path.trim().length > 0
        ? `?path=${encodeURIComponent(path.trim())}`
        : "";
      const res = await fetch(`/api/filesystem/directory${query}`);
      const data = (await res.json().catch(() => null)) as
        | { currentPath?: string; entries?: DirectoryEntry[]; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to load directory (${res.status})`);
      }
      const nextPath = typeof data?.currentPath === "string" ? data.currentPath : "";
      setCurrentPath(nextPath);
      setEntries(Array.isArray(data?.entries) ? data.entries : []);
      setManualPath(nextPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  const handleGoParent = () => {
    if (!currentPath) return;
    const normalized = currentPath.replace(/\\/g, "/");
    if (normalized === "/") return;
    const parts = normalized.split("/").filter(Boolean);
    const parent = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/";
    void loadDirectory(parent);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 px-3"
      onClick={() => {
        onClose();
        onSelect(null);
      }}
      role="presentation"
    >
      <div
        className="h-[75vh] w-full max-w-[760px] overflow-hidden rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b border-[var(--vk-border)] px-4 py-3">
          <h3 className="text-[16px] text-[var(--vk-text-strong)]">{title}</h3>
          <p className="pt-1 text-[12px] text-[var(--vk-text-muted)]">{description}</p>
        </header>

        <div className="flex h-[calc(75vh-118px)] min-h-0 flex-col gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder="/path/to/repository"
              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
            />
            <button
              type="button"
              onClick={() => {
                void loadDirectory(manualPath);
              }}
              className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
            >
              Open
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void loadDirectory();
              }}
              className="inline-flex h-8 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
            >
              Home
            </button>
            <button
              type="button"
              onClick={handleGoParent}
              className="inline-flex h-8 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
            >
              Up
            </button>
            <div className="truncate text-[12px] text-[var(--vk-text-muted)]">{currentPath || "Home"}</div>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--vk-text-muted)]" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter folders"
              className="h-8 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent pl-7 pr-2 text-[12px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-[4px] border border-[var(--vk-border)]">
            {loading ? (
              <div className="px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">Loading...</div>
            ) : error ? (
              <div className="px-3 py-3 text-[12px] text-[var(--vk-red)]">{error}</div>
            ) : filteredEntries.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">No folders found.</div>
            ) : (
              <div className="p-1">
                {filteredEntries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => {
                      if (!entry.isDirectory) return;
                      void loadDirectory(entry.path);
                    }}
                    className={`mb-1 flex w-full items-center gap-2 rounded-[4px] px-2 py-2 text-left text-[12px] ${
                      entry.isDirectory
                        ? "text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                        : "cursor-default text-[var(--vk-text-muted)]"
                    }`}
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <span className="truncate">{entry.name}</span>
                    {entry.isGitRepo && (
                      <span className="ml-auto rounded-[999px] border border-[var(--vk-border)] px-1.5 py-0.5 text-[10px]">
                        git
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
          <button
            type="button"
            onClick={() => {
              onClose();
              onSelect(null);
            }}
            className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              const selectedPath = manualPath.trim().length > 0 ? manualPath.trim() : currentPath;
              onClose();
              onSelect(selectedPath || null);
            }}
            className="inline-flex h-9 items-center rounded-[4px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)]"
          >
            Use this folder
          </button>
        </footer>
      </div>
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
  hasProject,
  creating,
  error,
  onOpenAddWorkspace,
  onCreate,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  selectedAgent: string;
  setSelectedAgent: (value: string) => void;
  agentOptions: string[];
  projectLabel: string;
  hasProject: boolean;
  creating: boolean;
  error: string | null;
  onOpenAddWorkspace: () => void;
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
            <div className="flex items-center gap-2">
              {!hasProject ? (
                <button
                  type="button"
                  onClick={onOpenAddWorkspace}
                  className="inline-flex min-h-[29px] items-center justify-center rounded-[3px] border border-[var(--vk-border)] px-2 text-[13px] text-[var(--vk-text-normal)] transition-colors hover:bg-[var(--vk-bg-hover)]"
                >
                  Add Workspace
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onCreate}
                  disabled={creating || prompt.trim().length === 0}
                  className="inline-flex min-h-[29px] items-center justify-center rounded-[3px] bg-[var(--vk-bg-active)] px-2 text-[16px] text-[var(--vk-text-normal)] transition-colors hover:bg-[var(--vk-bg-hover)] disabled:opacity-45"
                >
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
                </button>
              )}
            </div>
          </div>
        </div>

        {error && <p className="pt-2 text-[12px] text-[var(--vk-red)]">{error}</p>}
      </div>
    </section>
  );
}

function SettingsDialog({
  open,
  mode,
  creating,
  error,
  current,
  agentOptions,
  onRepositoriesChanged,
  onClose,
  onSave,
}: {
  open: boolean;
  mode: PreferencesDialogMode;
  creating: boolean;
  error: string | null;
  current: PreferencesPayload;
  agentOptions: string[];
  onRepositoriesChanged?: () => Promise<void>;
  onClose: () => void;
  onSave: (next: PreferencesPayload) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("preferences");
  const [codingAgent, setCodingAgent] = useState(current.codingAgent);
  const [ide, setIde] = useState(current.ide);
  const [markdownEditor, setMarkdownEditor] = useState(current.markdownEditor);
  const [soundEnabled, setSoundEnabled] = useState(current.notifications.soundEnabled);
  const [soundFile, setSoundFile] = useState<string | null>(current.notifications.soundFile);
  const [repositories, setRepositories] = useState<RepositorySettingsPayload[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesSaving, setRepositoriesSaving] = useState(false);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [repositoryDraft, setRepositoryDraft] = useState<RepositorySettingsPayload | null>(null);
  const [repositoryBranchOptions, setRepositoryBranchOptions] = useState<string[]>([]);
  const [repositoryBranchesLoading, setRepositoryBranchesLoading] = useState(false);
  const [repositoryBranchesError, setRepositoryBranchesError] = useState<string | null>(null);
  const [repositoryFolderPickerOpen, setRepositoryFolderPickerOpen] = useState(false);

  const isBusy = creating || repositoriesSaving;

  function hydrateRepositoryDraft(value: RepositorySettingsPayload): RepositorySettingsPayload {
    return {
      ...value,
      pathHealth: {
        exists: value.pathHealth.exists,
        isGitRepository: value.pathHealth.isGitRepository,
        suggestedPath: value.pathHealth.suggestedPath,
      },
    };
  }

  async function loadRepositories(preferredRepositoryId?: string): Promise<void> {
    setRepositoriesLoading(true);
    setRepositoriesError(null);
    try {
      const res = await fetch("/api/repositories");
      const data = (await res.json().catch(() => null)) as
        | { repositories?: RepositorySettingsPayload[]; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to load repositories (${res.status})`);
      }
      const items = Array.isArray(data?.repositories) ? data.repositories : [];
      setRepositories(items);

      const fallbackId = items[0]?.id ?? "";
      const selectedId = preferredRepositoryId && items.some((item) => item.id === preferredRepositoryId)
        ? preferredRepositoryId
        : selectedRepositoryId && items.some((item) => item.id === selectedRepositoryId)
          ? selectedRepositoryId
          : fallbackId;

      setSelectedRepositoryId(selectedId);
    } catch (err) {
      setRepositories([]);
      setSelectedRepositoryId("");
      setRepositoryDraft(null);
      setRepositoriesError(err instanceof Error ? err.message : "Failed to load repositories");
    } finally {
      setRepositoriesLoading(false);
    }
  }

  async function detectRepositoryBranches(pathOverride?: string, preferredBranch?: string): Promise<void> {
    const repositoryPath = pathOverride ?? repositoryDraft?.path ?? "";
    const trimmedPath = repositoryPath.trim();
    if (trimmedPath.length === 0) {
      setRepositoryBranchesError("Select a repository path first.");
      setRepositoryBranchOptions([]);
      return;
    }

    setRepositoryBranchesLoading(true);
    setRepositoryBranchesError(null);
    try {
      const params = new URLSearchParams({ path: trimmedPath });
      const res = await fetch(`/api/workspaces/branches?${params.toString()}`);
      const data = (await res.json().catch(() => null)) as
        | { branches?: string[]; defaultBranch?: string | null; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to detect branches (${res.status})`);
      }

      const branches = Array.isArray(data?.branches)
        ? data.branches.filter((branch) => typeof branch === "string" && branch.trim().length > 0)
        : [];
      setRepositoryBranchOptions(branches);

      const suggestedDefault = preferredBranch?.trim()
        || (typeof data?.defaultBranch === "string" && data.defaultBranch.trim().length > 0
          ? data.defaultBranch.trim()
          : branches[0] ?? "");

      if (!suggestedDefault) return;
      setRepositoryDraft((prev) => {
        if (!prev) return prev;
        if (prev.defaultBranch.trim().length > 0 && branches.includes(prev.defaultBranch)) {
          return prev;
        }
        return { ...prev, defaultBranch: suggestedDefault };
      });
    } catch (err) {
      setRepositoryBranchOptions([]);
      setRepositoryBranchesError(err instanceof Error ? err.message : "Failed to detect branches");
    } finally {
      setRepositoryBranchesLoading(false);
    }
  }

  async function handleSaveRepository(): Promise<void> {
    if (!repositoryDraft || repositoriesSaving) return;
    if (repositoryDraft.repo.trim().length === 0 || repositoryDraft.path.trim().length === 0) return;

    setRepositoriesSaving(true);
    setRepositoriesError(null);
    try {
      const res = await fetch("/api/repositories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: repositoryDraft.id,
          displayName: repositoryDraft.displayName,
          repo: repositoryDraft.repo,
          path: repositoryDraft.path,
          defaultWorkingDirectory: repositoryDraft.defaultWorkingDirectory,
          defaultBranch: repositoryDraft.defaultBranch,
          devServerScript: repositoryDraft.devServerScript,
          setupScript: repositoryDraft.setupScript,
          runSetupInParallel: repositoryDraft.runSetupInParallel,
          cleanupScript: repositoryDraft.cleanupScript,
          archiveScript: repositoryDraft.archiveScript,
          copyFiles: repositoryDraft.copyFiles,
        }),
      });

      const data = (await res.json().catch(() => null)) as
        | { repository?: RepositorySettingsPayload; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to save repository settings (${res.status})`);
      }

      const saved = data?.repository;
      if (!saved) {
        throw new Error("Repository saved but response is missing repository data");
      }

      setRepositories((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
      setRepositoryDraft(hydrateRepositoryDraft(saved));
      setSelectedRepositoryId(saved.id);
      setRepositoryBranchesError(null);

      await detectRepositoryBranches(saved.path, saved.defaultBranch);

      if (onRepositoriesChanged) {
        await onRepositoriesChanged();
      }
    } catch (err) {
      setRepositoriesError(err instanceof Error ? err.message : "Failed to save repository settings");
    } finally {
      setRepositoriesSaving(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setActiveTab("preferences");
    setCodingAgent(current.codingAgent);
    setIde(current.ide);
    setMarkdownEditor(current.markdownEditor);
    setSoundEnabled(current.notifications.soundEnabled);
    setSoundFile(current.notifications.soundFile);
    setRepositoryBranchOptions([]);
    setRepositoryBranchesError(null);
  }, [current, open]);

  useEffect(() => {
    if (!open || mode !== "settings") return;
    void loadRepositories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  useEffect(() => {
    if (!open || mode !== "settings") return;
    if (!selectedRepositoryId) {
      setRepositoryDraft(null);
      return;
    }
    const selected = repositories.find((item) => item.id === selectedRepositoryId);
    if (!selected) return;
    setRepositoryDraft(hydrateRepositoryDraft(selected));
    setRepositoryBranchOptions([]);
    setRepositoryBranchesError(null);
    if (selected.path.trim().length > 0) {
      void detectRepositoryBranches(selected.path, selected.defaultBranch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, repositories, selectedRepositoryId]);

  const visibleTabs = useMemo(() => {
    if (mode === "onboarding") {
      return SETTINGS_TABS.filter((tab) => tab.id === "preferences");
    }
    return SETTINGS_TABS;
  }, [mode]);

  const activeTabItem = visibleTabs.find((tab) => tab.id === activeTab) ?? visibleTabs[0] ?? SETTINGS_TABS[0];
  const isPreferencesTab = activeTabItem.id === "preferences";
  const isRepositoriesTab = activeTabItem.id === "repositories";

  const orderedAgentOptions = useMemo(() => {
    const opts = new Set(agentOptions);
    if (codingAgent.trim().length > 0) {
      opts.add(codingAgent);
    }
    if (opts.size === 0) {
      opts.add("qwen-code");
    }
    const rankMap = new Map(EXECUTOR_ORDER.map((name, index) => [name, index]));
    return [...opts].sort((left, right) => {
      const leftRank = rankMap.get(normalizeAgentName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankMap.get(normalizeAgentName(right)) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return getAgentLabel(left).localeCompare(getAgentLabel(right));
    });
  }, [agentOptions, codingAgent]);

  if (!open) return null;

  const canSubmitPreferences = codingAgent.trim().length > 0
    && ide.trim().length > 0
    && markdownEditor.trim().length > 0;
  const canSaveRepository = !!repositoryDraft
    && repositoryDraft.displayName.trim().length > 0
    && repositoryDraft.repo.trim().length > 0
    && repositoryDraft.path.trim().length > 0
    && repositoryDraft.defaultBranch.trim().length > 0;

  async function handleSubmitPreferences() {
    if (!canSubmitPreferences || creating) return;
    const resolvedSoundFile = soundEnabled
      ? soundFile ?? NOTIFICATION_SOUND_OPTIONS[0]?.id ?? "abstract-sound-4"
      : null;

    await onSave({
      onboardingAcknowledged: mode === "onboarding" ? true : current.onboardingAcknowledged,
      codingAgent: codingAgent.trim(),
      ide: ide.trim(),
      markdownEditor: markdownEditor.trim(),
      notifications: {
        soundEnabled,
        soundFile: resolvedSoundFile,
      },
    });
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-3 py-3"
        onClick={() => {
          if (isBusy || mode === "onboarding" || repositoryFolderPickerOpen) return;
          onClose();
        }}
        role="presentation"
      >
        <div
          className="flex h-[min(92vh,760px)] w-full max-w-[1120px] overflow-hidden rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
          onClick={(event) => event.stopPropagation()}
        >
          <aside className="flex w-[224px] shrink-0 flex-col border-r border-[var(--vk-border)] bg-[rgba(28,28,28,0.8)]">
            <header className="border-b border-[var(--vk-border)] px-4 py-4">
              <h2 className="text-[27px] leading-[27px] text-[var(--vk-text-strong)]">Settings</h2>
            </header>
            <nav className="space-y-1 overflow-auto p-2">
              {visibleTabs.map((tab) => {
                const Icon = tab.icon;
                const selected = activeTabItem.id === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    disabled={isBusy}
                    className={`flex w-full items-center gap-3 rounded-[3px] px-3 py-2 text-left text-[14px] leading-[21px] transition-colors ${
                      selected
                        ? "bg-[rgba(234,122,42,0.1)] text-[var(--vk-orange)]"
                        : "text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                    } disabled:opacity-50`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex items-center justify-between border-b border-[var(--vk-border)] px-4 py-4">
              <h3 className="text-[27px] leading-[27px] text-[var(--vk-text-strong)]">
                {mode === "onboarding" && isPreferencesTab ? "2. Confirm your preferences" : activeTabItem.label}
              </h3>
              <button
                type="button"
                onClick={onClose}
                disabled={isBusy || mode === "onboarding"}
                aria-label="Close settings"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
              {isPreferencesTab ? (
                <div className="space-y-5">
                  <section className="space-y-2">
                    <h4 className="text-[15px] font-medium text-[var(--vk-text-strong)]">Choose Your Coding Agent</h4>
                    <p className="text-[12px] text-[var(--vk-text-muted)]">Select the default coding agent configuration.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {orderedAgentOptions.map((agent) => {
                        const selected = codingAgent === agent;
                        return (
                          <button
                            key={agent}
                            type="button"
                            onClick={() => setCodingAgent(agent)}
                            className={`flex items-center gap-2 rounded-[4px] border px-3 py-2 text-left ${
                              selected
                                ? "border-[var(--vk-orange)] bg-[var(--vk-bg-hover)]"
                                : "border-[var(--vk-border)] hover:bg-[var(--vk-bg-hover)]"
                            }`}
                          >
                            <AgentTileIcon seed={{ label: agent }} className="h-5 w-5 border-none bg-transparent" />
                            <span className="flex-1 text-[13px] text-[var(--vk-text-normal)]">{getAgentLabel(agent)}</span>
                            {selected && <Check className="h-3.5 w-3.5 text-[var(--vk-orange)]" />}
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="space-y-2">
                    <h4 className="text-[15px] font-medium text-[var(--vk-text-strong)]">Choose Your Code Editor</h4>
                    <p className="text-[12px] text-[var(--vk-text-muted)]">This editor will be used when opening attempts and files.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {IDE_OPTIONS.map((option) => {
                        const selected = ide === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => setIde(option.id)}
                            className={`flex items-center gap-2 rounded-[4px] border px-3 py-2 text-left ${
                              selected
                                ? "border-[var(--vk-orange)] bg-[var(--vk-bg-hover)]"
                                : "border-[var(--vk-border)] hover:bg-[var(--vk-bg-hover)]"
                            }`}
                          >
                            <CodeEditorIcon editorId={option.id} label={option.label} />
                            <span className="flex-1 text-[13px] text-[var(--vk-text-normal)]">{option.label}</span>
                            {selected && <Check className="h-3.5 w-3.5 text-[var(--vk-orange)]" />}
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="space-y-2">
                    <h4 className="text-[15px] font-medium text-[var(--vk-text-strong)]">Markdown Editor</h4>
                    <p className="text-[12px] text-[var(--vk-text-muted)]">
                      Used as your second-brain markdown source when feeding context into tasks.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {MARKDOWN_EDITOR_OPTIONS.map((option) => {
                        const selected = markdownEditor === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => setMarkdownEditor(option.id)}
                            className={`flex items-center gap-2 rounded-[4px] border px-3 py-2 text-left ${
                              selected
                                ? "border-[var(--vk-orange)] bg-[var(--vk-bg-hover)]"
                                : "border-[var(--vk-border)] hover:bg-[var(--vk-bg-hover)]"
                            }`}
                          >
                            <MarkdownEditorIcon editorId={option.id} />
                            <span className="flex-1 text-[13px] text-[var(--vk-text-normal)]">{option.label}</span>
                            {selected && <Check className="h-3.5 w-3.5 text-[var(--vk-orange)]" />}
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="space-y-2">
                    <h4 className="text-[15px] font-medium text-[var(--vk-text-strong)]">Notification Sound</h4>
                    <p className="text-[12px] text-[var(--vk-text-muted)]">Pick a sound for notifications, or disable sound.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {NOTIFICATION_SOUND_OPTIONS.map((option) => {
                        const selected = soundEnabled && soundFile === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => {
                              setSoundEnabled(true);
                              setSoundFile(option.id);
                            }}
                            className={`flex items-center gap-2 rounded-[4px] border px-3 py-2 text-left ${
                              selected
                                ? "border-[var(--vk-orange)] bg-[var(--vk-bg-hover)]"
                                : "border-[var(--vk-border)] hover:bg-[var(--vk-bg-hover)]"
                            }`}
                          >
                            <Volume2 className="h-4 w-4 text-[var(--vk-text-muted)]" />
                            <span className="flex-1 text-[13px] text-[var(--vk-text-normal)]">{option.label}</span>
                            {selected && <Check className="h-3.5 w-3.5 text-[var(--vk-orange)]" />}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => setSoundEnabled(false)}
                        className={`flex items-center gap-2 rounded-[4px] border px-3 py-2 text-left ${
                          !soundEnabled
                            ? "border-[var(--vk-orange)] bg-[var(--vk-bg-hover)]"
                            : "border-[var(--vk-border)] hover:bg-[var(--vk-bg-hover)]"
                        }`}
                      >
                        <VolumeX className="h-4 w-4 text-[var(--vk-text-muted)]" />
                        <span className="flex-1 text-[13px] text-[var(--vk-text-normal)]">No sound</span>
                        {!soundEnabled && <Check className="h-3.5 w-3.5 text-[var(--vk-orange)]" />}
                      </button>
                    </div>
                  </section>
                </div>
              ) : isRepositoriesTab ? (
                <div className="space-y-5">
                  <section className="space-y-1">
                    <h4 className="text-[24px] leading-[24px] text-[var(--vk-text-strong)]">Repository Configuration</h4>
                    <p className="text-[14px] text-[var(--vk-text-muted)]">
                      Configure scripts and defaults used whenever this repository is selected for workspaces.
                    </p>
                  </section>

                  <section className="space-y-2">
                    <label className="block">
                      <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Select Repository</span>
                      <select
                        value={selectedRepositoryId}
                        onChange={(event) => setSelectedRepositoryId(event.target.value)}
                        disabled={repositoriesLoading || repositories.length === 0 || isBusy}
                        className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)] disabled:opacity-60"
                      >
                        {repositories.length === 0 && <option value="">No repositories configured</option>}
                        {repositories.map((repository) => (
                          <option key={repository.id} value={repository.id}>
                            {repository.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="text-[12px] text-[var(--vk-text-muted)]">
                      Select a repository to view and edit its configuration.
                    </p>
                    {repositoriesLoading && (
                      <p className="text-[12px] text-[var(--vk-text-muted)]">Loading repositories...</p>
                    )}
                  </section>

                  {repositoryDraft && (
                    <>
                      <section className="space-y-3 border-t border-[var(--vk-border)] pt-4">
                        <h5 className="text-[22px] leading-[22px] text-[var(--vk-text-strong)]">General Settings</h5>
                        <p className="text-[13px] text-[var(--vk-text-muted)]">Configure basic repository information.</p>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Display Name</span>
                          <input
                            value={repositoryDraft.displayName}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, displayName: event.target.value } : prev)}
                            className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">A friendly name for this repository.</p>
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Repository Path</span>
                          <div className="flex items-center gap-2">
                            <input
                              value={repositoryDraft.path}
                              readOnly
                              onClick={() => setRepositoryFolderPickerOpen(true)}
                              placeholder="Use Browse to select a repository folder"
                              className="h-9 w-full cursor-pointer rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            />
                            <button
                              type="button"
                              onClick={() => setRepositoryFolderPickerOpen(true)}
                              disabled={isBusy}
                              className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
                            >
                              <FolderOpen className="h-4 w-4" />
                            </button>
                          </div>
                          {!repositoryDraft.pathHealth.exists && (
                            <p className="mt-1 text-[12px] text-[var(--vk-red)]">Configured path does not exist on disk.</p>
                          )}
                          {repositoryDraft.pathHealth.exists && !repositoryDraft.pathHealth.isGitRepository && (
                            <p className="mt-1 text-[12px] text-[var(--vk-red)]">Configured path exists but is not a git repository.</p>
                          )}
                          {repositoryDraft.pathHealth.suggestedPath && (
                            <button
                              type="button"
                              onClick={() => {
                                const suggestedPath = repositoryDraft.pathHealth.suggestedPath ?? "";
                                if (!suggestedPath) return;
                                setRepositoryDraft((prev) => prev
                                  ? {
                                      ...prev,
                                      path: suggestedPath,
                                      pathHealth: {
                                        ...prev.pathHealth,
                                        exists: true,
                                        isGitRepository: true,
                                        suggestedPath: null,
                                      },
                                    }
                                  : prev);
                                void detectRepositoryBranches(suggestedPath);
                              }}
                              className="mt-1 inline-flex h-7 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[11px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                            >
                              Use detected git repo path
                            </button>
                          )}
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Default Working Directory</span>
                          <input
                            value={repositoryDraft.defaultWorkingDirectory}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, defaultWorkingDirectory: event.target.value } : prev)}
                            placeholder="e.g., packages/frontend"
                            className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                            Subdirectory relative to the repository root where the coding agent starts.
                          </p>
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Default Target Branch</span>
                          <div className="flex items-center gap-2">
                            <input
                              value={repositoryDraft.defaultBranch}
                              onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, defaultBranch: event.target.value } : prev)}
                              placeholder="Select a branch"
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                void detectRepositoryBranches();
                              }}
                              disabled={repositoryBranchesLoading}
                              className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
                              title="Detect branches"
                            >
                              {repositoryBranchesLoading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RefreshCcw className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                          {repositoryBranchOptions.length > 0 && (
                            <select
                              value={repositoryDraft.defaultBranch}
                              onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, defaultBranch: event.target.value } : prev)}
                              className="mt-2 h-8 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[12px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            >
                              {repositoryBranchOptions.map((branch) => (
                                <option key={branch} value={branch}>
                                  {branch}
                                </option>
                              ))}
                            </select>
                          )}
                          {repositoryBranchesError && (
                            <p className="mt-1 text-[12px] text-[var(--vk-red)]">{repositoryBranchesError}</p>
                          )}
                        </label>
                      </section>

                      <section className="space-y-3 border-t border-[var(--vk-border)] pt-4">
                        <h5 className="text-[22px] leading-[22px] text-[var(--vk-text-strong)]">Scripts & Configuration</h5>
                        <p className="text-[13px] text-[var(--vk-text-muted)]">
                          Configure dev server, setup, cleanup, archive, and file-copy behavior for this repository.
                        </p>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Dev Server Script</span>
                          <textarea
                            rows={3}
                            value={repositoryDraft.devServerScript}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, devServerScript: event.target.value } : prev)}
                            placeholder="npm run dev"
                            className="w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">Starts a development server for this repository.</p>
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Setup Script</span>
                          <textarea
                            rows={4}
                            value={repositoryDraft.setupScript}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, setupScript: event.target.value } : prev)}
                            placeholder="npm install"
                            className="w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                            Runs in the worktree after creation and before/with coding-agent startup.
                          </p>
                        </label>

                        <label className="flex items-start gap-2 rounded-[4px] border border-[var(--vk-border)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                          <input
                            type="checkbox"
                            checked={repositoryDraft.runSetupInParallel}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, runSetupInParallel: event.target.checked } : prev)}
                            className="mt-0.5 h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
                          />
                          <span>Run setup script in parallel with coding agent</span>
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Cleanup Script</span>
                          <textarea
                            rows={4}
                            value={repositoryDraft.cleanupScript}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, cleanupScript: event.target.value } : prev)}
                            placeholder="Runs when the workspace is archived and changes exist"
                            className="w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Archive Script</span>
                          <textarea
                            rows={4}
                            value={repositoryDraft.archiveScript}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, archiveScript: event.target.value } : prev)}
                            placeholder="Runs when the workspace/session is archived"
                            className="w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Copy Files</span>
                          <input
                            value={repositoryDraft.copyFiles}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, copyFiles: event.target.value } : prev)}
                            placeholder=".env, config/*.json"
                            className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                            Comma-separated relative file paths or glob patterns copied from the repo to each worktree.
                          </p>
                        </label>
                      </section>
                    </>
                  )}
                </div>
              ) : (
                <section className="space-y-3">
                  <h4 className="text-[16px] font-medium text-[var(--vk-text-strong)]">{activeTabItem.label}</h4>
                  <p className="text-[14px] text-[var(--vk-text-muted)]">
                    This section is queued for implementation. Preferences and repository settings are available now.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab("preferences")}
                    className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                  >
                    Open Preferences
                  </button>
                </section>
              )}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-[var(--vk-border)] px-4 py-3">
              <div className="min-w-0">
                {(isRepositoriesTab ? repositoriesError : error) && (
                  <p className="truncate rounded-[4px] border border-[var(--vk-red)]/35 bg-[var(--vk-red)]/10 px-2 py-1 text-[12px] text-[var(--vk-red)]">
                    {isRepositoriesTab ? repositoriesError : error}
                  </p>
                )}
                {!error && !repositoriesError && isPreferencesTab && (
                  <p className="text-[11px] text-[var(--vk-text-muted)]">
                    {mode === "onboarding"
                      ? "These preferences can be changed any time from Settings."
                      : "Preferences are saved to your conductor config and applied immediately."}
                  </p>
                )}
                {!error && !repositoriesError && isRepositoriesTab && (
                  <p className="text-[11px] text-[var(--vk-text-muted)]">
                    Repository settings are saved to your conductor config and used for future workspaces.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {mode === "settings" && (
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={isBusy}
                    className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    Close
                  </button>
                )}
                {isPreferencesTab && (
                  <button
                    type="button"
                    onClick={handleSubmitPreferences}
                    disabled={!canSubmitPreferences || creating}
                    className="inline-flex h-9 items-center rounded-[4px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    {creating ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Saving...
                      </>
                    ) : mode === "onboarding" ? "Continue" : "Save"}
                  </button>
                )}
                {isRepositoriesTab && mode === "settings" && (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSaveRepository();
                    }}
                    disabled={!canSaveRepository || repositoriesSaving || repositoriesLoading}
                    className="inline-flex h-9 items-center rounded-[4px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    {repositoriesSaving ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Saving...
                      </>
                    ) : "Save Repository"}
                  </button>
                )}
              </div>
            </footer>
          </div>
        </div>
      </div>

      <FolderPickerDialog
        open={repositoryFolderPickerOpen}
        initialPath={repositoryDraft?.path}
        title="Select Repository Path"
        description="Choose the local git repository folder."
        onClose={() => setRepositoryFolderPickerOpen(false)}
        onSelect={(selectedPath) => {
          setRepositoryFolderPickerOpen(false);
          if (!selectedPath) return;
          setRepositoryDraft((prev) => prev
            ? {
                ...prev,
                path: selectedPath,
                pathHealth: {
                  ...prev.pathHealth,
                  exists: true,
                  isGitRepository: true,
                  suggestedPath: null,
                },
              }
            : prev);
          void detectRepositoryBranches(selectedPath);
        }}
      />
    </>
  );
}
