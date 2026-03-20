"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, memo, useCallback, useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { GitBranchIcon, LockIcon, MarkGithubIcon, RepoIcon } from "@primer/octicons-react";
import {
  getAvailableAgentModels,
  getAvailableAgentReasoningEfforts,
  getAgentModelCatalog,
  getDefaultAgentModel,
  getDefaultAgentReasoningEffort,
  resolveAgentModelAccess,
  supportsAgentModelSelection,
  type AgentModelOption,
  type AgentReasoningOption,
  type DashboardRole,
  type ModelAccessPreferences,
} from "@conductor-oss/core/types";
import type { IconType } from "react-icons";
import { SiNotion, SiObsidian } from "react-icons/si";
import { VscVscode } from "react-icons/vsc";
import {
  Bot,
  BookText,
  Building2,
  ChevronsRight,
  Check,
  ChevronDown,
  Copy,
  Eye,
  FolderOpen,
  FolderGit2,
  FolderKanban,
  Hand,
  List,
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
import { normalizeAgentName } from "@/lib/agentUtils";
import {
  getKnownAgent,
  KNOWN_AGENTS,
  KNOWN_AGENT_ORDER,
} from "@/lib/knownAgents";
import { useSession } from "@/hooks/useSession";
import { useSessions } from "@/hooks/useSessions";
import { useConfig, type ConfigProject } from "@/hooks/useConfig";
import { useNotificationAlerts } from "@/hooks/useNotificationAlerts";
import { useAgents } from "@/hooks/useAgents";
import { useResponsiveSidebarStateWithOptions } from "@/hooks/useResponsiveSidebarState";
import { AppShell } from "@/components/layout/AppShell";
import { TopBar } from "@/components/layout/TopBar";
import { BridgeStatusPill } from "@/components/bridge/BridgeStatusPill";
import { shouldUseCompactTerminalChrome } from "@/components/sessions/sessionTerminalUtils";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { normalizeModelAccessPreferences } from "@/lib/modelAccess";
import {
  getRuntimeCatalogDefaultModelForAccess,
  getRuntimeCatalogDefaultReasoning,
  getRuntimeCatalogModelsForAccess,
  getRuntimeCatalogReasoningOptions,
  type RuntimeAgentModelCatalog,
} from "@/lib/runtimeAgentModelsShared";

const DEFAULT_AGENT = "claude-code";
const SESSION_DETAIL_KEEPALIVE_LIMIT = 1;
type DashboardWorkspaceView = "chat" | "board";

function normalizeDashboardQueryValue(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function resolveDashboardWorkspaceView(value: string | null): DashboardWorkspaceView {
  return value === "board" ? "board" : "chat";
}

const SessionDetail = dynamic(
  () => import("@/components/sessions/SessionDetail").then((mod) => mod.SessionDetail),
  {
    loading: () => (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading session...
      </div>
    ),
  },
);

const WorkspaceSidebarPanel = dynamic(
  () => import("@/components/layout/WorkspaceSidebarPanel").then((mod) => mod.WorkspaceSidebarPanel),
  {
    loading: () => (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading workspace panel...
      </div>
    ),
  },
);

const WorkspaceOverview = dynamic(
  () => import("@/features/dashboard/components/WorkspaceOverview").then((mod) => mod.WorkspaceOverview),
  {
    loading: () => (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading workspace...
      </div>
    ),
  },
);

const WorkspaceKanban = dynamic(
  () => import("@/components/board/WorkspaceKanban").then((mod) => mod.WorkspaceKanban),
  {
    loading: () => (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        Loading board...
      </div>
    ),
  },
);

const NewWorkspaceDialog = dynamic(
  () => import("@/features/dashboard/components/DashboardDialogs").then((mod) => mod.NewWorkspaceDialog),
  { loading: () => null },
);

const SettingsDialog = dynamic(
  () => import("@/features/dashboard/components/DashboardDialogs").then((mod) => mod.SettingsDialog),
  { loading: () => null },
);

function getAgentLabel(value: string): string {
  const known = getKnownAgent(value);
  if (known?.label) return known.label;
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatCurrentModelLabel(agentName: string, modelId: string): string {
  const normalizedModel = modelId.trim();
  const normalizedAgent = normalizeAgentName(agentName);
  if (!normalizedModel) return normalizedModel;

  if (normalizedAgent === "claude-code") {
    const lower = normalizedModel.toLowerCase();
    if (lower === "opus") return "Claude Opus";
    if (lower === "sonnet") return "Claude Sonnet";
    if (lower === "haiku") return "Claude Haiku";
    const match = lower.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-\d{8})?$/);
    if (match) {
      const family = match[1];
      return `Claude ${family[0]?.toUpperCase() + family.slice(1)} ${match[2]}.${match[3]}`;
    }
  }

  return normalizedModel
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((segment) => {
      const lower = segment.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (/^\d+(?:\.\d+)?$/.test(segment)) return segment;
      return segment[0]?.toUpperCase() + segment.slice(1);
    })
    .join("-");
}

function suggestWorkspaceId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function extractNameFromPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) ?? null;
}

function extractRepositoryNameFromGitUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const sshMatch = trimmed.match(/^git@[^:]+:([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return sshMatch[2] ?? null;
  }

  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    return last ? last.replace(/\.git$/i, "") : null;
  } catch {
    return null;
  }
}

function normalizeGitHubRepositoryUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}.git`;
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}.git`;
  }

  return null;
}

function normalizeManualGitUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(https?:\/\/|git@)/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function formatRepoUpdatedLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return `Updated ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp))}`;
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

type CreatePermissionMode = "default" | "auto" | "ask" | "plan";

type CreateSessionOptions = {
  projectId?: string;
  branch?: string;
  baseBranch?: string;
  useWorktree?: boolean;
  permissionMode?: CreatePermissionMode;
  issueId?: string;
};

type LinkedBoardTask = {
  id: string;
  text: string;
  issueId: string | null;
  taskRef: string | null;
  type: string | null;
  priority: string | null;
};

type LinkedBoardResponse = {
  columns?: Array<{
    tasks?: LinkedBoardTask[];
  }>;
};

type GitHubRepo = {
  name: string;
  fullName: string;
  httpsUrl: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
  description?: string | null;
  updatedAt?: string | null;
  ownerLogin?: string | null;
  permission?: string | null;
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
  markdownEditorPath: string;
  modelAccess: ModelAccessPreferences;
  notifications: {
    soundEnabled: boolean;
    soundFile: string | null;
  };
};

type AccessIdentitySummary = {
  authenticated: boolean;
  role: DashboardRole | null;
  email: string | null;
  provider: string | null;
};

function getLinkedTaskValue(task: LinkedBoardTask): string {
  return task.issueId?.trim() || task.taskRef?.trim() || task.id;
}

function getLinkedTaskTitle(text: string): string {
  const [title] = text.split(" - ");
  return (title ?? text).trim();
}

type AccessSettingsPayload = {
  requireAuth: boolean;
  defaultRole: DashboardRole;
  trustedHeaders: {
    enabled: boolean;
    provider: "cloudflare-access";
    emailHeader: string;
    jwtHeader: string;
    teamDomain: string;
    audience: string;
  };
  roles: {
    viewers: string;
    operators: string;
    admins: string;
    viewerDomains: string;
    operatorDomains: string;
    adminDomains: string;
  };
  current: AccessIdentitySummary;
};

type RemoteAccessPayload = {
  publicUrl: string | null;
  connectUrl: string | null;
  shareable: boolean;
  status: "disabled" | "starting" | "ready" | "error";
  provider: "tailscale" | null;
  recommendedProvider: "tailscale" | null;
  localUrl: string | null;
  managed: boolean;
  installed: boolean;
  connected: boolean;
  canAutoInstall: boolean;
  autoInstallMethod: "brew" | null;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  mode: "cloudflare-access" | "private-network" | "enterprise-only" | "generic-header" | "clerk" | "local-only" | "misconfigured" | "unsafe-public";
  title: string;
  description: string;
  warnings: string[];
  nextSteps: string[];
};

type RemoteAccessAction = "enable" | "rotate" | "disable";

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
  agent: string;
  agentPermissions: string;
  agentModel: string;
  agentReasoningEffort: string;
  workspaceMode: string;
  runtimeMode: string;
  scmMode: string;
  defaultWorkingDirectory: string;
  defaultBranch: string;
  devServerScript: string;
  devServerCwd: string;
  devServerUrl: string;
  devServerPort: string;
  devServerHost: string;
  devServerPath: string;
  devServerHttps: boolean;
  setupScript: string;
  runSetupInParallel: boolean;
  cleanupScript: string;
  archiveScript: string;
  copyFiles: string;
  pathHealth: RepositoryPathHealth;
};

type ModelSelectionState = {
  catalogModel: string;
  customModel: string;
  reasoningEffort: string;
};

type AgentSetupState = {
  name: string;
  ready: boolean;
  installed: boolean;
  configured: boolean;
  homepage: string | null;
  description: string | null;
  installHint: string | null;
  installUrl: string | null;
  setupUrl: string | null;
};

type PreferencesDialogMode = "onboarding" | "settings";
type SettingsTabId =
  | "general"
  | "remote_access"
  | "repositories"
  | "organization"
  | "projects"
  | "agents"
  | "mcp"
  | "preferences";

type SettingsTab = {
  id: SettingsTabId;
  label: string;
  icon: LucideIcon;
  implemented: boolean;
};

const SETTINGS_TABS: SettingsTab[] = [
  { id: "general", label: "General", icon: Settings2, implemented: true },
  { id: "remote_access", label: "Remote Access", icon: SlidersHorizontal, implemented: true },
  { id: "repositories", label: "Repositories", icon: FolderGit2, implemented: true },
  { id: "organization", label: "Organization Settings", icon: Building2, implemented: true },
  { id: "projects", label: "Projects", icon: FolderKanban, implemented: false },
  { id: "agents", label: "Agents", icon: Bot, implemented: true },
  { id: "mcp", label: "MCP Servers", icon: PlugZap, implemented: false },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal, implemented: false },
];

const ONBOARDING_TABS: SettingsTab[] = [
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal, implemented: true },
  { id: "repositories", label: "Repository", icon: FolderGit2, implemented: true },
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

const IDE_SUBMENU_OPTIONS = IDE_OPTIONS.filter((option) => option.id !== "custom");

function resolveIdeOption(editorId: string): { id: string; label: string } {
  return IDE_OPTIONS.find((option) => option.id === editorId) ?? { id: editorId, label: editorId };
}

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
  const markdownEditorPath = typeof payload["markdownEditorPath"] === "string"
    ? payload["markdownEditorPath"].trim()
    : "";

  return {
    onboardingAcknowledged: payload["onboardingAcknowledged"] === true,
    codingAgent,
    ide,
    markdownEditor,
    markdownEditorPath,
    modelAccess: normalizeModelAccessPreferences(payload["modelAccess"]),
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

function normalizeMultilineList(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value !== "string") return "";
  return value
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAccessSettings(value: unknown, summary?: unknown): AccessSettingsPayload {
  const payload = toObject(value);
  const trustedHeaders = toObject(payload["trustedHeaders"]);
  const roles = toObject(payload["roles"]);
  const current = toObject(summary);
  const defaultRoleRaw = payload["defaultRole"];
  const defaultRole: DashboardRole =
    defaultRoleRaw === "viewer" || defaultRoleRaw === "admin" || defaultRoleRaw === "operator"
      ? defaultRoleRaw
      : "operator";
  const currentRoleRaw = current["role"];

  return {
    requireAuth: payload["requireAuth"] === true || trustedHeaders["enabled"] === true,
    defaultRole,
    trustedHeaders: {
      enabled: trustedHeaders["enabled"] === true,
      provider: "cloudflare-access",
      emailHeader: typeof trustedHeaders["emailHeader"] === "string" && trustedHeaders["emailHeader"].trim().length > 0
        ? trustedHeaders["emailHeader"].trim()
        : "Cf-Access-Authenticated-User-Email",
      jwtHeader: typeof trustedHeaders["jwtHeader"] === "string" && trustedHeaders["jwtHeader"].trim().length > 0
        ? trustedHeaders["jwtHeader"].trim()
        : "Cf-Access-Jwt-Assertion",
      teamDomain: typeof trustedHeaders["teamDomain"] === "string" && trustedHeaders["teamDomain"].trim().length > 0
        ? trustedHeaders["teamDomain"].trim()
        : "",
      audience: typeof trustedHeaders["audience"] === "string" && trustedHeaders["audience"].trim().length > 0
        ? trustedHeaders["audience"].trim()
        : "",
    },
    roles: {
      viewers: normalizeMultilineList(roles["viewers"]),
      operators: normalizeMultilineList(roles["operators"]),
      admins: normalizeMultilineList(roles["admins"]),
      viewerDomains: normalizeMultilineList(roles["viewerDomains"]),
      operatorDomains: normalizeMultilineList(roles["operatorDomains"]),
      adminDomains: normalizeMultilineList(roles["adminDomains"]),
    },
    current: {
      authenticated: current["authenticated"] === true,
      role: currentRoleRaw === "viewer" || currentRoleRaw === "operator" || currentRoleRaw === "admin"
        ? currentRoleRaw
        : null,
      email: typeof current["email"] === "string" && current["email"].trim().length > 0
        ? current["email"].trim()
        : null,
      provider: typeof current["provider"] === "string" && current["provider"].trim().length > 0
        ? current["provider"].trim()
        : null,
    },
  };
}

function normalizeRemoteAccess(value: unknown): RemoteAccessPayload {
  const payload = toObject(value);
  const mode = payload["mode"];
  const status = payload["status"];
  const provider = payload["provider"];
  const autoInstallMethod = payload["autoInstallMethod"];

  return {
    publicUrl: typeof payload["publicUrl"] === "string" && payload["publicUrl"].trim().length > 0
      ? payload["publicUrl"].trim()
      : null,
    connectUrl: typeof payload["connectUrl"] === "string" && payload["connectUrl"].trim().length > 0
      ? payload["connectUrl"].trim()
      : null,
    shareable: payload["shareable"] === true,
    status:
      status === "starting"
      || status === "ready"
      || status === "error"
      || status === "disabled"
        ? status
        : "disabled",
    provider: provider === "tailscale" ? provider : null,
    recommendedProvider:
      payload["recommendedProvider"] === "tailscale"
        ? payload["recommendedProvider"]
        : null,
    localUrl: typeof payload["localUrl"] === "string" && payload["localUrl"].trim().length > 0
      ? payload["localUrl"].trim()
      : null,
    managed: payload["managed"] === true,
    installed: payload["installed"] === true,
    connected: payload["connected"] === true,
    canAutoInstall: payload["canAutoInstall"] === true,
    autoInstallMethod: autoInstallMethod === "brew" ? "brew" : null,
    lastError: typeof payload["lastError"] === "string" && payload["lastError"].trim().length > 0
      ? payload["lastError"].trim()
      : null,
    startedAt: typeof payload["startedAt"] === "string" && payload["startedAt"].trim().length > 0
      ? payload["startedAt"].trim()
      : null,
    updatedAt: typeof payload["updatedAt"] === "string" && payload["updatedAt"].trim().length > 0
      ? payload["updatedAt"].trim()
      : null,
    mode:
      mode === "cloudflare-access"
      || mode === "private-network"
      || mode === "enterprise-only"
      || mode === "generic-header"
      || mode === "clerk"
      || mode === "local-only"
      || mode === "misconfigured"
      || mode === "unsafe-public"
        ? mode
        : "local-only",
    title: typeof payload["title"] === "string" && payload["title"].trim().length > 0
      ? payload["title"].trim()
      : "Remote access",
    description: typeof payload["description"] === "string" && payload["description"].trim().length > 0
      ? payload["description"].trim()
      : "",
    warnings: normalizeStringArray(payload["warnings"]),
    nextSteps: normalizeStringArray(payload["nextSteps"]),
  };
}

function getRemoteAccessModeLabel(mode: RemoteAccessPayload["mode"]): string {
  switch (mode) {
    case "cloudflare-access":
      return "Cloudflare Access";
    case "private-network":
      return "Private network";
    case "enterprise-only":
      return "Enterprise only";
    case "generic-header":
      return "Legacy mode blocked";
    case "clerk":
      return "Clerk";
    case "misconfigured":
      return "Auth required";
    case "unsafe-public":
      return "Blocked until protected";
    case "local-only":
    default:
      return "Local only";
  }
}

function getRemoteAccessStatusLabel(status: RemoteAccessPayload["status"]): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    case "disabled":
    default:
      return "Disabled";
  }
}

function emptyModelSelection(): ModelSelectionState {
  return {
    catalogModel: "",
    customModel: "",
    reasoningEffort: "",
  };
}

function getRuntimeModelCatalog(
  agent: string,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): RuntimeAgentModelCatalog | null {
  return runtimeModelCatalogs[normalizeAgentName(agent)] ?? null;
}

function getAllRuntimeCatalogModels(
  runtimeCatalog: RuntimeAgentModelCatalog | null,
): AgentModelOption[] {
  if (!runtimeCatalog) return [];

  const ordered: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const group of Object.values(runtimeCatalog.modelsByAccess)) {
    if (!Array.isArray(group)) continue;
    for (const model of group) {
      if (!model?.id || seen.has(model.id)) continue;
      seen.add(model.id);
      ordered.push(model);
    }
  }
  return ordered;
}

function getSelectableAgentModels(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): AgentModelOption[] {
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);
  const scopedModels = getRuntimeCatalogModelsForAccess(runtimeCatalog, access);
  const staticModels = getAvailableAgentModels(agent, modelAccess);
  const merged: AgentModelOption[] = [];
  const seen = new Set<string>();

  for (const model of [...scopedModels, ...staticModels, ...getAllRuntimeCatalogModels(runtimeCatalog)]) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }

  return merged;
}

function getSelectableAgentReasoningOptions(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
  model: string | null | undefined,
): AgentReasoningOption[] {
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);
  const runtimeOptions = getRuntimeCatalogReasoningOptions(runtimeCatalog, model, access);
  const staticOptions = getAvailableAgentReasoningEfforts(agent, modelAccess);
  const merged: AgentReasoningOption[] = [];
  const seen = new Set<string>();

  for (const option of [...runtimeOptions, ...staticOptions]) {
    if (!option?.id || seen.has(option.id)) continue;
    seen.add(option.id);
    merged.push(option);
  }

  return merged;
}

function getSelectableDefaultAgentModel(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): string {
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);
  return getRuntimeCatalogDefaultModelForAccess(runtimeCatalog, access)
    ?? getDefaultAgentModel(agent, modelAccess)
    ?? getAllRuntimeCatalogModels(runtimeCatalog)[0]?.id
    ?? "";
}

function getSelectableDefaultReasoningEffort(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
  model: string | null | undefined,
): string {
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  const access = resolveAgentModelAccess(agent, modelAccess);
  return getRuntimeCatalogDefaultReasoning(runtimeCatalog, model, access)
    ?? getDefaultAgentReasoningEffort(agent, modelAccess)
    ?? "";
}

function getSelectableModelPlaceholder(
  agent: string,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
): string {
  const runtimeCatalog = getRuntimeModelCatalog(agent, runtimeModelCatalogs);
  if (runtimeCatalog?.customModelPlaceholder.trim()) {
    return runtimeCatalog.customModelPlaceholder;
  }
  const label = getAgentModelCatalog(agent)?.label ?? "agent";
  return `Enter exact ${label} model id`;
}

function buildModelSelection(
  agent: string,
  modelAccess: ModelAccessPreferences,
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>,
  preferredModel?: string | null,
  preferredReasoningEffort?: string | null,
): ModelSelectionState {
  const trimmedPreferred = preferredModel?.trim() ?? "";
  const trimmedPreferredReasoning = preferredReasoningEffort?.trim().toLowerCase() ?? "";
  const availableModels = getSelectableAgentModels(agent, modelAccess, runtimeModelCatalogs);
  const defaultModel = getSelectableDefaultAgentModel(agent, modelAccess, runtimeModelCatalogs);
  const resolveReasoningEffort = (resolvedModel: string | null | undefined): string => {
    const options = getSelectableAgentReasoningOptions(agent, modelAccess, runtimeModelCatalogs, resolvedModel);
    if (trimmedPreferredReasoning.length > 0 && options.some((option) => option.id === trimmedPreferredReasoning)) {
      return trimmedPreferredReasoning;
    }
    return getSelectableDefaultReasoningEffort(agent, modelAccess, runtimeModelCatalogs, resolvedModel);
  };

  if (trimmedPreferred.length > 0) {
    if (availableModels.some((model) => model.id === trimmedPreferred)) {
      return {
        catalogModel: trimmedPreferred,
        customModel: "",
        reasoningEffort: resolveReasoningEffort(trimmedPreferred),
      };
    }

    return {
      catalogModel: defaultModel,
      customModel: trimmedPreferred,
      reasoningEffort: resolveReasoningEffort(trimmedPreferred),
    };
  }

  return {
    catalogModel: defaultModel,
    customModel: "",
    reasoningEffort: resolveReasoningEffort(defaultModel),
  };
}

function resolveModelSelectionValue(selection: ModelSelectionState): string | undefined {
  const custom = selection.customModel.trim();
  if (custom.length > 0) return custom;
  const catalog = selection.catalogModel.trim();
  return catalog.length > 0 ? catalog : undefined;
}

function resolveReasoningSelectionValue(selection: ModelSelectionState): string | undefined {
  const reasoningEffort = selection.reasoningEffort.trim().toLowerCase();
  return reasoningEffort.length > 0 ? reasoningEffort : undefined;
}

function getAgentModelAccessLabel(agent: string, modelAccess: ModelAccessPreferences): string | null {
  const catalog = getAgentModelCatalog(agent);
  if (!catalog || catalog.accessOptions.length <= 1) return null;
  const access = resolveAgentModelAccess(agent, modelAccess);
  if (!access) return null;

  return catalog.accessOptions.find((option) => option.id === access)?.label ?? null;
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

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function buildRepositoryBootstrapCommand(
  repository: RepositorySettingsPayload,
  preferences: Pick<PreferencesPayload, "ide" | "markdownEditor">,
): string {
  const initArgs = [
    "npx conductor-oss@latest setup",
    "--yes",
    `--path ${shellQuote(repository.path)}`,
    `--project-id ${shellQuote(repository.id)}`,
    `--display-name ${shellQuote(repository.displayName)}`,
    `--agent ${shellQuote(repository.agent || "claude-code")}`,
    `--ide ${shellQuote(preferences.ide)}`,
    `--markdown-editor ${shellQuote(preferences.markdownEditor)}`,
  ];

  if (repository.repo.trim().length > 0) {
    initArgs.push(`--repo ${shellQuote(repository.repo.trim())}`);
  }
  if (repository.defaultBranch.trim().length > 0) {
    initArgs.push(`--default-branch ${shellQuote(repository.defaultBranch.trim())}`);
  }
  if (repository.agentModel.trim().length > 0) {
    initArgs.push(`--model ${shellQuote(repository.agentModel.trim())}`);
  }
  if (repository.agentReasoningEffort.trim().length > 0) {
    initArgs.push(`--reasoning-effort ${shellQuote(repository.agentReasoningEffort.trim())}`);
  }
  if (repository.defaultWorkingDirectory.trim().length > 0) {
    initArgs.push(`--default-working-directory ${shellQuote(repository.defaultWorkingDirectory.trim())}`);
  }

  return initArgs.join(" ");
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

function AgentModelSelector({
  agent,
  modelAccess,
  runtimeModelCatalogs,
  selection,
  onChange,
  compact = false,
}: {
  agent: string;
  modelAccess: ModelAccessPreferences;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  selection: ModelSelectionState;
  onChange: (next: ModelSelectionState) => void;
  compact?: boolean;
}) {
  if (!supportsAgentModelSelection(agent)) return null;

  const catalog = getAgentModelCatalog(agent);
  const availableModels = getSelectableAgentModels(agent, modelAccess, runtimeModelCatalogs);
  const resolvedModel = resolveModelSelectionValue(selection) ?? selection.catalogModel;
  const availableReasoningOptions = getSelectableAgentReasoningOptions(
    agent,
    modelAccess,
    runtimeModelCatalogs,
    resolvedModel,
  );
  const accessLabel = getAgentModelAccessLabel(agent, modelAccess);

  if (!catalog) return null;

  return (
    <div className={compact ? "grid gap-3 md:grid-cols-3" : "space-y-3"}>
      <label className="block">
        <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Model</span>
        <select
          value={selection.catalogModel}
          disabled={availableModels.length === 0}
          onChange={(event) => {
            const nextCatalogModel = event.target.value;
            const nextReasoningOptions = getSelectableAgentReasoningOptions(
              agent,
              modelAccess,
              runtimeModelCatalogs,
              nextCatalogModel,
            );
            onChange({
              ...selection,
              catalogModel: nextCatalogModel,
              reasoningEffort: nextReasoningOptions.some((option) => option.id === selection.reasoningEffort)
                ? selection.reasoningEffort
                : getSelectableDefaultReasoningEffort(agent, modelAccess, runtimeModelCatalogs, nextCatalogModel),
            });
          }}
          className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)] disabled:opacity-60"
        >
          {availableModels.length === 0 && (
            <option value="">No runtime models detected</option>
          )}
          {availableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-[var(--vk-text-muted)]">
          {accessLabel
            ? `Filtered for ${accessLabel}.`
            : "Filtered for your current access preference."} Leave custom override blank to use this selection.
        </p>
      </label>

      {availableReasoningOptions.length > 0 && (
        <label className="block">
          <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Reasoning Effort</span>
          <select
            value={selection.reasoningEffort}
            onChange={(event) => {
              onChange({
                ...selection,
                reasoningEffort: event.target.value,
              });
            }}
            className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
          >
            {availableReasoningOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-[var(--vk-text-muted)]">
            Choose how much deliberate reasoning the CLI should use before it acts.
          </p>
        </label>
      )}

      <label className="block">
        <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Custom Model Override</span>
        <input
          value={selection.customModel}
          onChange={(event) => {
            const nextCustomModel = event.target.value;
            const nextResolvedModel = nextCustomModel.trim() || selection.catalogModel;
            const nextReasoningOptions = getSelectableAgentReasoningOptions(
              agent,
              modelAccess,
              runtimeModelCatalogs,
              nextResolvedModel,
            );
            onChange({
              ...selection,
              customModel: nextCustomModel,
              reasoningEffort: nextReasoningOptions.some((option) => option.id === selection.reasoningEffort)
                ? selection.reasoningEffort
                : getSelectableDefaultReasoningEffort(
                  agent,
                  modelAccess,
                  runtimeModelCatalogs,
                  nextResolvedModel,
                ),
            });
          }}
          placeholder={getSelectableModelPlaceholder(agent, runtimeModelCatalogs)}
          className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
        />
        <p className="mt-1 text-[11px] text-[var(--vk-text-muted)]">
          Optional. Use this to force an exact model id from the installed CLI when you want to override the detected list.
        </p>
      </label>
    </div>
  );
}

export default function DashboardClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedProjectId = useMemo(
    () => normalizeDashboardQueryValue(searchParams.get("project")),
    [searchParams],
  );
  const selectedSessionId = useMemo(
    () => normalizeDashboardQueryValue(searchParams.get("session")),
    [searchParams],
  );
  const workspaceView = useMemo(
    () => resolveDashboardWorkspaceView(searchParams.get("view")),
    [searchParams],
  );
  const terminalTabActive = useMemo(() => {
    const tab = searchParams.get("tab");
    return tab !== "overview" && tab !== "preview" && tab !== "diff";
  }, [searchParams]);
  const { projects, loading: configLoading, error: configError, refresh: refreshConfig } = useConfig();
  const { agents } = useAgents();
  const {
    mobileSidebarOpen,
    desktopSidebarOpen,
    toggleSidebar,
    closeSidebarOnMobile,
    syncSidebarForViewport,
  } = useResponsiveSidebarStateWithOptions({ initialDesktopOpen: false });
  const sidebarVisible = mobileSidebarOpen || desktopSidebarOpen;
  const needsSessionsList = !selectedSessionId || sidebarVisible;
  const { sessions, loading: sessionsLoading, error: sessionsError, refresh: refreshSessions } = useSessions(
    selectedProjectId,
    { enabled: needsSessionsList },
  );

  const [prompt, setPrompt] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [launchModelSelection, setLaunchModelSelection] = useState<ModelSelectionState>(emptyModelSelection());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [newWorkspaceError, setNewWorkspaceError] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<PreferencesPayload | null>(null);
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [preferencesDialogOpen, setPreferencesDialogOpen] = useState(false);
  const [pendingWorkspaceSetup, setPendingWorkspaceSetup] = useState(false);
  const [mountedSessionIds, setMountedSessionIds] = useState<string[]>(() => selectedSessionId ? [selectedSessionId] : []);
  const [compactTerminalChrome, setCompactTerminalChrome] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)")
      : null;
    const syncCompactTerminalChrome = () => {
      setCompactTerminalChrome(shouldUseCompactTerminalChrome());
    };

    syncCompactTerminalChrome();
    window.addEventListener("resize", syncCompactTerminalChrome);
    mediaQuery?.addEventListener?.("change", syncCompactTerminalChrome);

    return () => {
      window.removeEventListener("resize", syncCompactTerminalChrome);
      mediaQuery?.removeEventListener?.("change", syncCompactTerminalChrome);
    };
  }, []);

  const immersiveMobileMode = Boolean(selectedSessionId) && terminalTabActive && compactTerminalChrome;

  const dashboardSessions = sessions as unknown as DashboardSession[];
  const sessionsById = useMemo(
    () => new Map(dashboardSessions.map((session) => [session.id, session] as const)),
    [dashboardSessions],
  );
  const {
    session: selectedSessionRecord,
    loading: selectedSessionLoading,
    error: selectedSessionError,
  } = useSession(
    selectedSessionId,
    null,
    { enabled: Boolean(selectedSessionId) },
  );
  const workspaceError = createError ?? configError ?? sessionsError ?? selectedSessionError ?? preferencesError;
  const sessionsByProjectId = useMemo(() => {
    const grouped = new Map<string, DashboardSession[]>();
    for (const session of dashboardSessions) {
      const current = grouped.get(session.projectId);
      if (current) {
        current.push(session);
      } else {
        grouped.set(session.projectId, [session]);
      }
    }
    return grouped;
  }, [dashboardSessions]);

  const navigateDashboard = useCallback((
    updates: {
      projectId?: string | null;
      sessionId?: string | null;
      workspaceView?: DashboardWorkspaceView | null;
      tab?: "overview" | "chat" | "diff" | "preview" | null;
    },
    mode: "push" | "replace" = "push",
  ) => {
    const params = new URLSearchParams(searchParams.toString());

    const updateParam = (key: string, value: string | null | undefined) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed.length > 0) {
        params.set(key, trimmed);
        return;
      }
      params.delete(key);
    };

    if ("projectId" in updates) {
      updateParam("project", updates.projectId);
    }
    if ("sessionId" in updates) {
      updateParam("session", updates.sessionId);
    }
    if ("workspaceView" in updates) {
      if (updates.workspaceView === "board") {
        params.set("view", "board");
      } else {
        params.delete("view");
      }
    }
    if ("tab" in updates) {
      if (updates.tab && updates.tab !== "chat") {
        params.set("tab", updates.tab);
      } else {
        params.delete("tab");
      }
    }

    if (!params.has("project")) {
      params.delete("view");
    }
    if (!params.has("session")) {
      params.delete("tab");
    }

    const nextQuery = params.toString();
    const nextUrl = nextQuery.length > 0 ? `${pathname}?${nextQuery}` : pathname;
    if (mode === "replace") {
      router.replace(nextUrl, { scroll: false });
      return;
    }
    router.push(nextUrl, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    if (configLoading || configError) return;

    if (projects.length === 0) {
      if (selectedProjectId !== null) {
        navigateDashboard({ projectId: null, workspaceView: null }, "replace");
      }
      return;
    }

    if (selectedProjectId !== null && !projects.some((project) => project.id === selectedProjectId)) {
      navigateDashboard(
        {
          projectId: selectedSessionId ? null : projects[0]?.id ?? null,
          workspaceView: selectedSessionId ? null : workspaceView,
        },
        "replace",
      );
    }
  }, [configError, configLoading, navigateDashboard, projects, selectedProjectId, selectedSessionId, workspaceView]);

  useEffect(() => {
    if (!selectedSessionId) return;

    if (needsSessionsList) {
      if (sessionsLoading || sessionsError) return;
      if (!dashboardSessions.some((session) => session.id === selectedSessionId)) {
        navigateDashboard({ sessionId: null, tab: null }, "replace");
      }
      return;
    }

    if (selectedSessionLoading) return;
    if (!selectedSessionRecord) {
      navigateDashboard({ sessionId: null, tab: null }, "replace");
    }
  }, [
    dashboardSessions,
    navigateDashboard,
    needsSessionsList,
    selectedSessionId,
    selectedSessionLoading,
    selectedSessionRecord,
    sessionsError,
    sessionsLoading,
  ]);

  useEffect(() => {
    if (!selectedSessionId) {
      setMountedSessionIds([]);
      return;
    }

    setMountedSessionIds((current) => {
      const next = [selectedSessionId, ...current.filter((sessionId) => sessionId !== selectedSessionId)];
      return next.slice(0, SESSION_DETAIL_KEEPALIVE_LIMIT);
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId || !needsSessionsList || sessionsLoading || sessionsError) {
      return;
    }

    setMountedSessionIds((current) => current.filter((sessionId) => sessionId === selectedSessionId || sessionsById.has(sessionId)));
  }, [needsSessionsList, selectedSessionId, sessionsById, sessionsError, sessionsLoading]);

  const selectedSession = useMemo(
    () => selectedSessionRecord,
    [selectedSessionRecord],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedProjectSessions = useMemo(
    () => (selectedProjectId ? sessionsByProjectId.get(selectedProjectId) ?? [] : []),
    [selectedProjectId, sessionsByProjectId],
  );
  const topBarTitle = useMemo(() => {
    if (selectedSession) {
      return [selectedSession.projectId, selectedSession.branch].filter(Boolean).join(" \u00b7 ");
    }

    if (selectedProject) {
      return [selectedProject.id, selectedProject.defaultBranch || "main"].filter(Boolean).join(" \u00b7 ");
    }

    return "All Projects";
  }, [selectedProject, selectedSession]);

  const agentOptions = useMemo(() => {
    const safeAgents = Array.isArray(agents)
      ? agents as Array<{ name?: string; ready?: boolean; configured?: boolean; installed?: boolean }>
      : [];
    const opts = new Set<string>();

    for (const known of KNOWN_AGENTS) {
      opts.add(known.name);
    }
    for (const agent of safeAgents) {
      if (agent.name) {
        opts.add(agent.name);
      }
    }
    for (const project of projects) {
      if (project.agent) opts.add(project.agent);
    }
    if (preferences?.codingAgent) {
      opts.add(preferences.codingAgent);
    }
    if (selectedAgent) {
      opts.add(selectedAgent);
    }
    if (opts.size === 0) {
      opts.add(preferences?.codingAgent || DEFAULT_AGENT);
    }
    return [...opts];
  }, [agents, preferences?.codingAgent, projects, selectedAgent]);

  const agentStatesByName = useMemo(() => {
    const states: Record<string, AgentSetupState> = {};
    for (const known of KNOWN_AGENTS) {
      states[normalizeAgentName(known.name)] = {
        name: known.name,
        ready: false,
        installed: false,
        configured: false,
        homepage: known.homepage,
        description: known.description,
        installHint: known.installHint ?? null,
        installUrl: known.installUrl ?? known.homepage ?? null,
        setupUrl: known.setupUrl ?? known.homepage ?? null,
      };
    }
    const safeAgents = Array.isArray(agents)
      ? agents as Array<{
        name?: string;
        ready?: boolean;
        installed?: boolean;
        configured?: boolean;
        homepage?: string | null;
        description?: string | null;
        installHint?: string | null;
        installUrl?: string | null;
        setupUrl?: string | null;
      }>
      : [];

    for (const agent of safeAgents) {
      if (!agent.name) continue;
      const normalizedName = normalizeAgentName(agent.name);
      const known = getKnownAgent(agent.name);
      states[normalizeAgentName(agent.name)] = {
        name: known?.name ?? agent.name,
        ready: agent.ready === true,
        installed: agent.installed !== false,
        configured: agent.configured === true,
        homepage: typeof agent.homepage === "string"
          ? agent.homepage
          : known?.homepage ?? states[normalizedName]?.homepage ?? null,
        description: typeof agent.description === "string"
          ? agent.description
          : known?.description ?? states[normalizedName]?.description ?? null,
        installHint: typeof agent.installHint === "string"
          ? agent.installHint
          : known?.installHint ?? states[normalizedName]?.installHint ?? null,
        installUrl: typeof agent.installUrl === "string"
          ? agent.installUrl
          : known?.installUrl ?? states[normalizedName]?.installUrl ?? null,
        setupUrl: typeof agent.setupUrl === "string"
          ? agent.setupUrl
          : known?.setupUrl ?? states[normalizedName]?.setupUrl ?? null,
      };
    }

    return states;
  }, [agents]);

  const runtimeModelCatalogs = useMemo(() => {
    const catalogs: Record<string, RuntimeAgentModelCatalog> = {};
    const safeAgents = Array.isArray(agents)
      ? agents as Array<{ name?: string; runtimeModelCatalog?: RuntimeAgentModelCatalog | null }>
      : [];

    for (const agent of safeAgents) {
      if (!agent.name || !agent.runtimeModelCatalog) continue;
      catalogs[normalizeAgentName(agent.name)] = agent.runtimeModelCatalog;
    }

    return catalogs;
  }, [agents]);

  const openAgentSetup = useCallback((agentName: string) => {
    const normalized = normalizeAgentName(agentName);
    const agentState = agentStatesByName[normalized];
    const known = getKnownAgent(agentName);
    const target = agentState?.installed
      ? agentState?.setupUrl ?? known?.setupUrl ?? agentState?.homepage ?? known?.homepage
      : agentState?.installUrl
        ?? known?.installUrl
        ?? agentState?.setupUrl
        ?? known?.setupUrl
        ?? agentState?.homepage
        ?? known?.homepage;
    if (!target || typeof window === "undefined") return;
    window.open(target, "_blank", "noopener,noreferrer");
  }, [agentStatesByName]);

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
        const normalized = normalizePreferences(data?.preferences, DEFAULT_AGENT);
        setPreferences(normalized);
        setPreferencesError(null);
      } catch (err) {
        if (cancelled) return;
        setPreferences(normalizePreferences(null, DEFAULT_AGENT));
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
    if (agentOptions.length === 0) return;
    if (!selectedAgent || !agentOptions.includes(selectedAgent)) {
      const fallbackAgent = preferences?.codingAgent || DEFAULT_AGENT;
      setSelectedAgent(
        agentOptions.includes(fallbackAgent)
          ? fallbackAgent
          : agentOptions[0] ?? DEFAULT_AGENT,
      );
    }
  }, [agentOptions, preferences?.codingAgent, selectedAgent]);

  useEffect(() => {
    const effectiveAgent = selectedAgent || selectedProject?.agent || preferences?.codingAgent || DEFAULT_AGENT;
    const preferredModel = selectedProject && normalizeAgentName(selectedProject.agent) === normalizeAgentName(effectiveAgent)
      ? selectedProject.agentModel
      : null;
    const preferredReasoningEffort = selectedProject && normalizeAgentName(selectedProject.agent) === normalizeAgentName(effectiveAgent)
      ? selectedProject.agentReasoningEffort
      : null;

    setLaunchModelSelection(
      buildModelSelection(
        effectiveAgent,
        preferences?.modelAccess ?? normalizeModelAccessPreferences(null),
        runtimeModelCatalogs,
        preferredModel,
        preferredReasoningEffort,
      ),
    );
  }, [preferences?.modelAccess, preferences?.codingAgent, runtimeModelCatalogs, selectedAgent, selectedProject]);

  async function handleSavePreferences(
    next: PreferencesPayload,
    options?: { closeDialog?: boolean },
  ): Promise<boolean> {
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
      const normalized = normalizePreferences(data?.preferences, next.codingAgent || DEFAULT_AGENT);
      setPreferences(normalized);
      setSelectedAgent(normalized.codingAgent);
      if (options?.closeDialog !== false) {
        setPreferencesDialogOpen(false);
      }
      return true;
    } catch (err) {
      setPreferencesError(err instanceof Error ? err.message : "Failed to save preferences");
      return false;
    } finally {
      setPreferencesSaving(false);
    }
  }

  const openWorkspaceDialog = useCallback(() => {
    setNewWorkspaceError(null);
    setNewWorkspaceOpen(true);
    syncSidebarForViewport();
  }, [syncSidebarForViewport]);

  useEffect(() => {
    if (!pendingWorkspaceSetup || preferencesDialogOpen) return;
    setPendingWorkspaceSetup(false);
    openWorkspaceDialog();
  }, [pendingWorkspaceSetup, preferencesDialogOpen]);

  const handleCreateSession = useCallback(async (options?: CreateSessionOptions) => {
    const trimmedPrompt = prompt.trim();
    const resolvedModel = resolveModelSelectionValue(launchModelSelection);
    const resolvedReasoningEffort = resolveReasoningSelectionValue(launchModelSelection);

    const projectId = options?.projectId ?? selectedProjectId ?? projects[0]?.id;
    if (!projectId) {
      setCreateError("No project is configured in conductor.yaml");
      return;
    }

    const effectiveAgent = selectedAgent || DEFAULT_AGENT;
    const selectedAgentState = agentStatesByName[normalizeAgentName(effectiveAgent)] ?? null;
    if (selectedAgentState && !selectedAgentState.ready) {
      setCreateError(
        selectedAgentState.installed
          ? `${getAgentLabel(effectiveAgent)} is not ready yet. Finish setup or authentication and try again.`
          : `${getAgentLabel(effectiveAgent)} is not installed on this machine yet. Open setup and try again.`,
      );
      openAgentSetup(effectiveAgent);
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
          ...(options?.issueId?.trim() ? { issueId: options.issueId.trim() } : {}),
          agent: effectiveAgent,
          ...(options?.branch ? { branch: options.branch } : {}),
          ...(options?.baseBranch ? { baseBranch: options.baseBranch } : {}),
          ...(typeof options?.useWorktree === "boolean" ? { useWorktree: options.useWorktree } : {}),
          ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(resolvedReasoningEffort ? { reasoningEffort: resolvedReasoningEffort } : {}),
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
      syncSidebarForViewport();
      await refreshSessions();
      navigateDashboard(
        {
          projectId,
          sessionId: data.session.id,
          tab: null,
        },
        "push",
      );
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setCreating(false);
    }
  }, [
    agentStatesByName,
    launchModelSelection,
    navigateDashboard,
    openAgentSetup,
    projects,
    prompt,
    refreshSessions,
    selectedAgent,
    selectedProjectId,
    syncSidebarForViewport,
  ]);

  const handleArchiveSession = useCallback(async (sessionId: string) => {
    let res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
      method: "POST",
    });
    let data = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;

    if (res.status === 404) {
      res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "archive" }),
      });
      data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
    }

    if (!res.ok) {
      throw new Error(data?.error ?? `Failed to archive session: ${res.status}`);
    }

    if (selectedSessionId === sessionId) {
      navigateDashboard({ sessionId: null, tab: null }, "replace");
    }

    await refreshSessions();
  }, [navigateDashboard, refreshSessions, selectedSessionId]);

  const handleCreateWorkspace = useCallback(async (payload: NewWorkspacePayload) => {
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
      setPrompt("");
      syncSidebarForViewport();
      setNewWorkspaceOpen(false);
      navigateDashboard(
        {
          projectId: createdProjectId,
          sessionId: null,
          workspaceView: "chat",
          tab: null,
        },
        "push",
      );
    } catch (err) {
      setNewWorkspaceError(err instanceof Error ? err.message : "Failed to add workspace");
    } finally {
      setCreatingWorkspace(false);
    }
  }, [navigateDashboard, refreshConfig, syncSidebarForViewport]);

  const onboardingRequired = !preferencesLoading && !!preferences && !preferences.onboardingAcknowledged;
  const resolvedPreferences = preferences ?? normalizePreferences(null, selectedAgent || DEFAULT_AGENT);
  const resolvedCodingAgent = selectedAgent || resolvedPreferences.codingAgent || DEFAULT_AGENT;
  const notificationProjectId = selectedProjectId ?? selectedSessionRecord?.projectId ?? null;

  useNotificationAlerts({
    enabled: !preferencesLoading,
    projectId: notificationProjectId,
    preferences: resolvedPreferences.notifications,
  });

  const handleSelectProject = useCallback((projectId: string | null) => {
    navigateDashboard(
      {
        projectId,
        sessionId: null,
        workspaceView: projectId ? workspaceView : null,
        tab: null,
      },
      "push",
    );
    setSelectedAgent(preferences?.codingAgent || DEFAULT_AGENT);
    closeSidebarOnMobile();
  }, [closeSidebarOnMobile, navigateDashboard, preferences?.codingAgent, workspaceView]);

  const handleSelectSession = useCallback((id: string, options?: { tab?: "overview" | "preview" | "diff" }) => {
    const matchedSession = sessionsById.get(id) ?? null;
    navigateDashboard(
      {
        projectId: matchedSession?.projectId ?? selectedProjectId ?? null,
        sessionId: id,
        tab: options?.tab ?? null,
      },
      "push",
    );
    closeSidebarOnMobile();
  }, [closeSidebarOnMobile, navigateDashboard, selectedProjectId, sessionsById]);

  const handleOpenPreferences = useCallback(() => {
    setPreferencesDialogOpen(true);
  }, []);

  const handleCloseNewWorkspaceDialog = useCallback(() => {
    if (creatingWorkspace) return;
    setNewWorkspaceOpen(false);
  }, [creatingWorkspace]);

  const handleClosePreferencesDialog = useCallback(() => {
    if (preferencesSaving || onboardingRequired) return;
    setPreferencesDialogOpen(false);
    setPreferencesError(null);
  }, [onboardingRequired, preferencesSaving]);

  const handleUnlinkProject = useCallback(async (projectId: string) => {
    const encodedProjectId = encodeURIComponent(projectId);
    let res = await fetch(`/api/repositories/${encodedProjectId}`, { method: "DELETE" });

    // Fall back to the query-string endpoint for older servers that only expose DELETE /api/repositories?id=...
    if (res.status === 404 || res.status === 405) {
      res = await fetch(`/api/repositories?id=${encodedProjectId}`, { method: "DELETE" });
    }

    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok) {
      throw new Error(data?.error ?? `Failed to unlink project (${res.status})`);
    }
    await refreshConfig();
  }, [refreshConfig]);

  const sidebarContent = useMemo(() => {
    if (!sidebarVisible) {
      return null;
    }

    return (
      <WorkspaceSidebarPanel
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={handleSelectProject}
        onUnlinkProject={handleUnlinkProject}
        sessions={dashboardSessions}
        selectedSessionId={selectedSessionId}
        onSelectSession={handleSelectSession}
        onArchiveSession={handleArchiveSession}
        onCreateWorkspace={openWorkspaceDialog}
      />
    );
  }, [
    dashboardSessions,
    handleArchiveSession,
    handleSelectProject,
    handleSelectSession,
    handleUnlinkProject,
    openWorkspaceDialog,
    projects,
    selectedProjectId,
    selectedSessionId,
    sidebarVisible,
  ]);

  const workspaceMainPanel = useMemo(() => {
    if (workspaceView === "board") {
      return (
        <WorkspaceKanban
          projectId={selectedProjectId}
          defaultAgent={resolvedCodingAgent}
          agentOptions={agentOptions}
          projectSessions={selectedProjectSessions}
        />
      );
    }

    return (
      <CreateWorkspacePanel
        prompt={prompt}
        setPrompt={setPrompt}
        selectedAgent={resolvedCodingAgent}
        setSelectedAgent={setSelectedAgent}
        agentStates={agentStatesByName}
        modelSelection={launchModelSelection}
        setModelSelection={setLaunchModelSelection}
        modelAccess={resolvedPreferences.modelAccess}
        runtimeModelCatalogs={runtimeModelCatalogs}
        agentOptions={agentOptions}
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={handleSelectProject}
        projectLabel={selectedProjectId ?? "All projects"}
        hasProject={projects.length > 0}
        creating={creating}
        error={workspaceError}
        onOpenAddWorkspace={openWorkspaceDialog}
        onOpenAgentSetup={openAgentSetup}
        onCreate={handleCreateSession}
      />
    );
  }, [
    agentOptions,
    agentStatesByName,
    creating,
    handleCreateSession,
    launchModelSelection,
    openAgentSetup,
    openWorkspaceDialog,
    projects,
    selectedProjectSessions,
    prompt,
    resolvedCodingAgent,
    resolvedPreferences.modelAccess,
    runtimeModelCatalogs,
    selectedProjectId,
    setPrompt,
    workspaceError,
    workspaceView,
  ]);

  const projectWorkspaceContent = useMemo(() => {
    if (!selectedProject) return workspaceMainPanel;

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                Project Workspace
              </p>
              <p className="mt-1 truncate text-[14px] text-[var(--vk-text-strong)]">
                {selectedProject.id} · {selectedProject.defaultBranch || "main"}
              </p>
            </div>

            <div className="inline-flex w-fit rounded-[6px] border border-[var(--vk-border)] p-1">
              <button
                type="button"
                onClick={() => navigateDashboard({ projectId: selectedProject.id, workspaceView: "chat" }, "replace")}
                className={`min-h-[32px] rounded-[4px] px-3 text-[13px] ${
                  workspaceView === "chat"
                    ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                    : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                }`}
              >
                CLI launchpad
              </button>
              <button
                type="button"
                onClick={() => navigateDashboard({ projectId: selectedProject.id, workspaceView: "board" }, "replace")}
                className={`min-h-[32px] rounded-[4px] px-3 text-[13px] ${
                  workspaceView === "board"
                    ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                    : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                }`}
              >
                Board view
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {workspaceMainPanel}
        </div>
      </div>
    );
  }, [navigateDashboard, selectedProject, workspaceMainPanel, workspaceView]);

  const workspaceContent = useMemo(() => {
    if (selectedSessionId) {
      return (
        <div className="relative min-h-0 h-full min-w-0 flex-1 overflow-hidden">
          {mountedSessionIds.map((sessionId) => {
            const sessionActive = sessionId === selectedSessionId;
            const initialSession = sessionActive ? selectedSession : sessionsById.get(sessionId) ?? null;
            return (
              <div
                key={sessionId}
                aria-hidden={!sessionActive}
                className={sessionActive
                  ? "relative h-full min-w-0"
                  : "pointer-events-none absolute inset-0 overflow-hidden invisible"}
              >
                <SessionDetail
                  sessionId={sessionId}
                  initialSession={initialSession}
                  active={sessionActive}
                  immersiveMobileMode={sessionActive && immersiveMobileMode}
                  onOpenSidebar={toggleSidebar}
                />
              </div>
            );
          })}
        </div>
      );
    }

    if (selectedProjectId !== null) {
      return (
        <div className="min-h-0 flex-1 overflow-hidden">
          {projectWorkspaceContent}
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden">
        <WorkspaceOverview
          projects={projects}
          sessions={dashboardSessions}
          onCreateWorkspace={openWorkspaceDialog}
          onSelectSession={handleSelectSession}
        />
      </div>
    );
  }, [
    dashboardSessions,
    mountedSessionIds,
    projectWorkspaceContent,
    selectedSession,
    selectedSessionId,
    handleSelectSession,
    openWorkspaceDialog,
    projects,
    selectedProjectId,
    sessionsById,
    toggleSidebar,
  ]);

  return (
    <>
      <AppShell
        mobileSidebarOpen={mobileSidebarOpen}
        desktopSidebarOpen={desktopSidebarOpen}
        onToggleSidebar={toggleSidebar}
        hideMobileSidebarToggle={immersiveMobileMode}
        sidebar={sidebarContent}
      >
        {immersiveMobileMode ? null : (
          <TopBar
            title={topBarTitle}
            onOpenPreferences={handleOpenPreferences}
            rightContent={<BridgeStatusPill />}
          />
        )}

        <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${immersiveMobileMode ? "bg-[#060404]" : ""}`}>
          {workspaceContent}
        </div>
      </AppShell>

      {newWorkspaceOpen ? (
        <NewWorkspaceDialog
          open={newWorkspaceOpen}
          onClose={handleCloseNewWorkspaceDialog}
          onCreate={handleCreateWorkspace}
          creating={creatingWorkspace}
          error={newWorkspaceError}
          defaultAgent={resolvedCodingAgent}
          agentOptions={agentOptions}
        />
      ) : null}

      {preferencesDialogOpen || onboardingRequired ? (
        <SettingsDialog
          open={preferencesDialogOpen}
          mode={onboardingRequired ? "onboarding" : "settings"}
          creating={preferencesSaving}
          error={preferencesError}
          current={resolvedPreferences}
          projectCount={projects.length}
          agentOptions={agentOptions}
          agentStates={agentStatesByName}
          runtimeModelCatalogs={runtimeModelCatalogs}
          onRepositoriesChanged={refreshConfig}
          onOnboardingComplete={({ needsProject }) => {
            if (needsProject) {
              setPendingWorkspaceSetup(true);
            }
          }}
          onOpenAgentSetup={openAgentSetup}
          onClose={handleClosePreferencesDialog}
          onSave={handleSavePreferences}
        />
      ) : null}
    </>
  );
}

const CreateWorkspacePanel = memo(function CreateWorkspacePanel({
  prompt,
  setPrompt,
  selectedAgent,
  setSelectedAgent,
  agentStates,
  modelSelection,
  setModelSelection,
  modelAccess,
  runtimeModelCatalogs,
  agentOptions,
  projects,
  selectedProjectId,
  onSelectProject,
  projectLabel,
  hasProject,
  creating,
  error,
  onOpenAddWorkspace,
  onOpenAgentSetup,
  onCreate,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  selectedAgent: string;
  setSelectedAgent: (value: string) => void;
  agentStates: Record<string, AgentSetupState>;
  modelSelection: ModelSelectionState;
  setModelSelection: (next: ModelSelectionState) => void;
  modelAccess: ModelAccessPreferences;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  agentOptions: string[];
  projects: ConfigProject[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  projectLabel: string;
  hasProject: boolean;
  creating: boolean;
  error: string | null;
  onOpenAddWorkspace: () => void;
  onOpenAgentSetup: (agent: string) => void;
  onCreate: (options?: CreateSessionOptions) => void;
}) {
  const orderedAgentOptions = useMemo(() => {
    const rankMap = new Map(KNOWN_AGENT_ORDER.map((name, index) => [name, index]));
    return [...agentOptions].sort((left, right) => {
      const leftRank = rankMap.get(normalizeAgentName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankMap.get(normalizeAgentName(right)) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return getAgentLabel(left).localeCompare(getAgentLabel(right));
    });
  }, [agentOptions]);

  const selectedAgentLabel = getAgentLabel(selectedAgent);
  const selectedAgentState = agentStates[normalizeAgentName(selectedAgent)] ?? null;
  const projectOptions = useMemo(
    () => [...projects].sort((left, right) => left.id.localeCompare(right.id)),
    [projects],
  );
  const effectiveProjectId = selectedProjectId ?? projectOptions[0]?.id ?? null;
  const selectedProject = useMemo(
    () => projectOptions.find((project) => project.id === effectiveProjectId) ?? null,
    [effectiveProjectId, projectOptions],
  );
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [issueId, setIssueId] = useState("");
  const [availableTasks, setAvailableTasks] = useState<LinkedBoardTask[]>([]);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [permissionMode, setPermissionMode] = useState<CreatePermissionMode>("default");

  useEffect(() => {
    if (!selectedProject) {
      setBranchOptions([]);
      setSelectedBranch("");
      setBranchLoading(false);
      return;
    }
    setBranchOptions([]);
    setSelectedBranch(selectedProject.defaultBranch.trim() || "main");
    setBranchLoading(false);
  }, [selectedProject]);

  useEffect(() => {
    if (!effectiveProjectId) {
      setAvailableTasks([]);
      setIssueId("");
      setTaskLoading(false);
      return;
    }
    setAvailableTasks([]);
    setIssueId("");
    setTaskLoading(false);
  }, [effectiveProjectId]);

  const loadBranches = useCallback(async () => {
    if (!selectedProject) return;

    const fallbackBranch = selectedProject.defaultBranch.trim() || "main";
    if (!selectedProject.path?.trim()) {
      setBranchOptions([fallbackBranch]);
      setSelectedBranch((current) => current.trim().length > 0 ? current : fallbackBranch);
      return;
    }

    setBranchLoading(true);
    try {
      const params = new URLSearchParams({ path: selectedProject.path });
      const res = await fetch(`/api/workspaces/branches?${params.toString()}`);
      const data = (await res.json().catch(() => null)) as
        | { branches?: string[]; defaultBranch?: string | null }
        | null;

      const branches = Array.isArray(data?.branches)
        ? data.branches.filter((branch) => typeof branch === "string" && branch.trim().length > 0)
        : [];
      const resolvedDefault = typeof data?.defaultBranch === "string" && data.defaultBranch.trim().length > 0
        ? data.defaultBranch.trim()
        : fallbackBranch;
      const nextBranches = branches.length > 0 ? branches : [resolvedDefault];

      setBranchOptions(nextBranches);
      setSelectedBranch((current) => current.trim().length > 0 && nextBranches.includes(current) ? current : resolvedDefault);
    } catch {
      setBranchOptions([fallbackBranch]);
      setSelectedBranch(fallbackBranch);
    } finally {
      setBranchLoading(false);
    }
  }, [selectedProject]);

  const loadTasks = useCallback(async () => {
    if (!effectiveProjectId) return;

    setTaskLoading(true);
    try {
      const res = await fetch(`/api/boards?projectId=${encodeURIComponent(effectiveProjectId)}`);
      const payload = (await res.json().catch(() => null)) as LinkedBoardResponse | { error?: string } | null;
      if (!res.ok) {
        throw new Error((payload as { error?: string } | null)?.error ?? `Failed to load tasks: ${res.status}`);
      }

      const boardPayload = payload as LinkedBoardResponse | null;
      const columns = Array.isArray(boardPayload?.columns) ? boardPayload.columns : [];
      const nextTasks = columns.flatMap((column: { tasks?: LinkedBoardTask[] }) =>
        Array.isArray(column.tasks) ? column.tasks : [],
      );
      const seen = new Set<string>();
      const deduped = nextTasks.filter((task: LinkedBoardTask) => {
        const key = getLinkedTaskValue(task);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      setAvailableTasks(deduped);
      setIssueId((current) => deduped.some((task: LinkedBoardTask) => getLinkedTaskValue(task) === current) ? current : "");
    } catch {
      setAvailableTasks([]);
      setIssueId("");
    } finally {
      setTaskLoading(false);
    }
  }, [effectiveProjectId]);

  useEffect(() => {
    if (!branchMenuOpen || branchLoading || branchOptions.length > 0) {
      return;
    }
    void loadBranches();
  }, [branchLoading, branchMenuOpen, branchOptions.length, loadBranches]);

  useEffect(() => {
    if (!taskMenuOpen || taskLoading || availableTasks.length > 0) {
      return;
    }
    void loadTasks();
  }, [availableTasks.length, loadTasks, taskLoading, taskMenuOpen]);

  const availableModels = useMemo(
    () => getSelectableAgentModels(selectedAgent, modelAccess, runtimeModelCatalogs),
    [modelAccess, runtimeModelCatalogs, selectedAgent],
  );
  const selectedTask = useMemo(
    () => availableTasks.find((task) => getLinkedTaskValue(task) === issueId) ?? null,
    [availableTasks, issueId],
  );
  const selectedModelValue = resolveModelSelectionValue(modelSelection) ?? "";
  const modelMenuOptions = useMemo(() => {
    const seen = new Set<string>();
    const merged: AgentModelOption[] = [];
    const currentModel = selectedModelValue.trim();

    for (const option of availableModels) {
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      merged.push(option);
    }

    if (currentModel && !seen.has(currentModel)) {
      seen.add(currentModel);
      merged.unshift({
        id: currentModel,
        label: formatCurrentModelLabel(selectedAgent, currentModel),
        description: "Current selected model.",
        access: [],
      });
    }

    return merged;
  }, [availableModels, selectedAgent, selectedModelValue]);
  const selectedModelLabel = useMemo(() => {
    if (selectedAgentState && !selectedAgentState.ready && !selectedModelValue) return "Setup required";
    if (!selectedModelValue) return "Default";
    return modelMenuOptions.find((option) => option.id === selectedModelValue)?.label ?? selectedModelValue;
  }, [modelMenuOptions, selectedAgentState, selectedModelValue]);
  const lightMenuClass = "z-50 min-w-[240px] max-w-[calc(100vw-32px)] rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.35)] sm:max-w-none";
  const scrollMenuClass = `${lightMenuClass} max-h-[min(360px,50vh)] overflow-y-auto`;
  const lightMenuItemClass = "flex min-h-[44px] cursor-default items-center gap-2 rounded-[3px] px-3 py-2 text-[14px] leading-[21px] text-[var(--vk-text-normal)] outline-none hover:bg-[var(--vk-bg-hover)] focus:bg-[var(--vk-bg-hover)] sm:min-h-[36px]";
  const permissionOptions: Array<{ id: CreatePermissionMode; label: string; icon: LucideIcon }> = [
    { id: "default", label: "Default", icon: SlidersHorizontal },
    { id: "auto", label: "Auto", icon: ChevronsRight },
    { id: "ask", label: "Ask", icon: Hand },
    { id: "plan", label: "Plan", icon: List },
  ];
  const selectedPermission = permissionOptions.find((option) => option.id === permissionMode) ?? permissionOptions[0];
  const getProjectDisplayName = (project: ConfigProject): string => {
    const repo = project.repo?.trim();
    if (repo) {
      const parts = repo.split("/").filter(Boolean);
      const label = parts[parts.length - 1]?.replace(/\.git$/i, "");
      if (label) return label;
    }
    return project.id;
  };
  const selectedProjectLabel = selectedProject ? getProjectDisplayName(selectedProject) : null;
  const currentProjectLabel = selectedProject
    ? `${selectedProjectLabel} · ${selectedBranch || selectedProject.defaultBranch || "main"}`
    : hasProject
      ? projectLabel
      : "Select project";
  const selectedTaskLabel = selectedTask?.taskRef?.trim() || "Link task";
  const selectedTaskSubtitle = selectedTask ? getLinkedTaskTitle(selectedTask.text) : "Choose a task, bug, or issue from this project's board";

  return (
    <section className="flex h-full min-h-0 items-start justify-center overflow-auto bg-[var(--vk-bg-main)] px-3 py-4 sm:items-center sm:px-6 sm:py-6">
      <div className="w-full max-w-[768px]">
        <h1 className="pb-4 text-center text-[30px] font-medium leading-[34px] tracking-[-0.7px] text-[var(--vk-text-strong)] sm:text-[36px] sm:leading-[40px] sm:tracking-[-0.9px]">
          What would you like to work on?
        </h1>

        <div className="mx-auto w-full rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-px">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--vk-border)] px-2 pb-[9px] pt-2">
            <AgentTileIcon seed={{ label: selectedAgent }} className="h-[25px] w-[25px] border-none bg-transparent" />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="inline-flex h-[31px] max-w-[70vw] items-center rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-[9px] py-[5px] text-[14px] leading-[21px] text-[var(--vk-text-normal)] outline-none hover:bg-[var(--vk-bg-hover)] data-[state=open]:bg-[var(--vk-bg-hover)] sm:max-w-none"
                  aria-label="Select agent"
                >
                  <span className="truncate pr-1">{selectedAgentLabel}</span>
                  <ChevronDown className="h-3 w-3 text-[var(--vk-text-muted)]" />
                </button>
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  sideOffset={6}
                  className={scrollMenuClass}
                >
                  <p className="px-3 pb-1 text-[14px] font-semibold leading-[21px] text-[var(--vk-text-muted)]">
                    Agents
                  </p>

                  {orderedAgentOptions.map((agent) => {
                    const isSelected = agent === selectedAgent;
                    const agentState = agentStates[normalizeAgentName(agent)] ?? null;
                    return (
                      <DropdownMenu.Item
                        key={agent}
                        onSelect={() => setSelectedAgent(agent)}
                        className={lightMenuItemClass}
                      >
                        <AgentTileIcon seed={{ label: agent }} className="h-6 w-6 border-none bg-transparent" />
                        <div className="min-w-0 flex-1">
                          <div>{getAgentLabel(agent)}</div>
                          {!agentState?.ready ? (
                            <div className="truncate text-[12px] leading-[16px] text-[var(--vk-text-muted)]">
                              {agentState?.installed ? "Setup required" : "Not installed"}
                            </div>
                          ) : null}
                        </div>
                        <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                          {isSelected ? <Check className="h-4 w-4" /> : null}
                        </span>
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>

            <DropdownMenu.Root onOpenChange={setTaskMenuOpen}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  disabled={!effectiveProjectId}
                  className="ml-auto flex h-[31px] min-w-[220px] items-center rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-[9px] py-[5px] text-left disabled:cursor-not-allowed disabled:opacity-50 sm:ml-0 sm:w-[286px]"
                  aria-label="Link task"
                >
                  <span className="pr-2 text-[12px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">Task</span>
                  <span className="min-w-0 flex-1 truncate text-[14px] leading-[21px] text-[var(--vk-text-normal)]">
                    {selectedTaskLabel}
                  </span>
                  <ChevronDown className="h-3 w-3 text-[var(--vk-text-muted)]" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  side="bottom"
                  sideOffset={6}
                  className={scrollMenuClass}
                >
                  <p className="px-3 pb-1 text-[14px] font-semibold leading-[21px] text-[var(--vk-text-muted)]">
                    Link task
                  </p>
                  <p className="px-3 pb-2 text-[12px] leading-[16px] text-[var(--text-faint)]">
                    {selectedTaskSubtitle}
                  </p>
                  <DropdownMenu.Item
                    onSelect={() => setIssueId("")}
                    className={lightMenuItemClass}
                  >
                    <span>No linked task</span>
                    <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                      {!issueId ? <Check className="h-4 w-4" /> : null}
                    </span>
                  </DropdownMenu.Item>
                  {taskLoading ? (
                    <div className="px-3 py-2 text-[12px] leading-[18px] text-[var(--vk-text-muted)]">
                      Loading board tasks...
                    </div>
                  ) : availableTasks.length > 0 ? (
                    availableTasks.map((task) => {
                      const taskValue = getLinkedTaskValue(task);
                      const title = getLinkedTaskTitle(task.text);
                      const secondary = [task.type, task.priority].filter(Boolean).join(" · ");
                      return (
                        <DropdownMenu.Item
                          key={taskValue}
                          onSelect={() => setIssueId(taskValue)}
                          className={`${lightMenuItemClass} min-w-[320px] items-start`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate">
                              {task.taskRef?.trim() || title}
                            </div>
                            <div className="truncate text-[12px] leading-[16px] text-[var(--text-faint)]">
                              {task.taskRef?.trim() ? title : taskValue}
                              {secondary ? ` · ${secondary}` : ""}
                            </div>
                          </div>
                          <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                            {issueId === taskValue ? <Check className="h-4 w-4" /> : null}
                          </span>
                        </DropdownMenu.Item>
                      );
                    })
                  ) : (
                    <div className="px-3 py-2 text-[12px] leading-[18px] text-[var(--vk-text-muted)]">
                      No existing tasks were found for this project.
                    </div>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>

          <div className="rounded-[3.5px]">
            <div className="flex flex-col gap-3 p-2">
              <div className="relative w-full">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Optional launch prompt. Leave empty to open the native CLI."
                  rows={1}
                  className="min-h-[24px] w-full resize-none bg-transparent pr-8 text-[16px] leading-[24px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                />
                <button
                  type="button"
                  aria-label="Preview"
                  className="absolute right-0 top-0 inline-flex h-[24px] w-[24px] items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                >
                  <Eye className="h-[14px] w-[14px]" />
                </button>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-2">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-[29px] w-[29px] items-center justify-center rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                        aria-label="Select workspace or project"
                      >
                        <SlidersHorizontal className="h-[15px] w-[15px]" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="start" sideOffset={6} className={scrollMenuClass}>
                        <p className="px-3 pb-1 text-[14px] font-semibold leading-[21px] text-[var(--vk-text-muted)]">Projects</p>
                        {projectOptions.map((project) => {
                          const displayName = getProjectDisplayName(project);
                          const secondaryLabel = project.id !== displayName
                            ? project.id
                            : project.path?.trim() || project.repo?.trim() || null;
                          return (
                            <DropdownMenu.Item
                              key={project.id}
                              onSelect={() => onSelectProject(project.id)}
                              className={`${lightMenuItemClass} min-w-[280px] items-start`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate">{displayName}</div>
                                {secondaryLabel ? (
                                  <div className="truncate text-[12px] leading-[16px] text-[var(--text-faint)]">
                                    {secondaryLabel}
                                  </div>
                                ) : null}
                              </div>
                              <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                                {project.id === effectiveProjectId ? <Check className="h-4 w-4" /> : null}
                              </span>
                            </DropdownMenu.Item>
                          );
                        })}
                        <DropdownMenu.Separator className="my-1 h-px bg-[var(--vk-border)]" />
                        <DropdownMenu.Item onSelect={onOpenAddWorkspace} className={lightMenuItemClass}>
                          <FolderOpen className="h-4 w-4" />
                          <span>Add Workspace</span>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>

                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-[29px] items-center gap-[4px] rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-[9px] py-[5px] text-[14px] leading-[21px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span>{selectedModelLabel}</span>
                        <ChevronDown className="h-[10px] w-[10px] text-[var(--vk-text-muted)]" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="start" sideOffset={6} className={lightMenuClass}>
                        <p className="px-3 pb-1 text-[14px] font-semibold leading-[21px] text-[var(--vk-text-muted)]">Model</p>
                        <DropdownMenu.Item
                          onSelect={() => setModelSelection(buildModelSelection(
                            selectedAgent,
                            modelAccess,
                            runtimeModelCatalogs,
                            selectedProject?.agentModel,
                            selectedProject?.agentReasoningEffort,
                          ))}
                          className={lightMenuItemClass}
                        >
                          <span>Default</span>
                          <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                            {!selectedModelValue ? <Check className="h-4 w-4" /> : null}
                          </span>
                        </DropdownMenu.Item>
                        {modelMenuOptions.map((option) => (
                          <DropdownMenu.Item
                            key={option.id}
                            onSelect={() => setModelSelection({
                              catalogModel: option.id,
                              customModel: "",
                              reasoningEffort: getSelectableDefaultReasoningEffort(
                                selectedAgent,
                                modelAccess,
                                runtimeModelCatalogs,
                                option.id,
                              ),
                            })}
                            className={lightMenuItemClass}
                          >
                            <span>{option.label}</span>
                            <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                              {selectedModelValue === option.id ? <Check className="h-4 w-4" /> : null}
                            </span>
                          </DropdownMenu.Item>
                        ))}
                        {modelMenuOptions.length === 0 ? (
                          <div className="px-3 py-2 text-[12px] leading-[18px] text-[var(--vk-text-muted)]">
                            Models will appear here after the selected agent is installed and its runtime catalog is detected.
                          </div>
                        ) : null}
                        {selectedAgentState && !selectedAgentState.ready ? (
                          <>
                            <DropdownMenu.Separator className="my-1 h-px bg-[var(--vk-border)]" />
                            <button
                              type="button"
                              onClick={() => onOpenAgentSetup(selectedAgent)}
                              className="flex w-full items-center rounded-[3px] px-3 py-2 text-left text-[13px] text-[var(--vk-orange)] transition hover:bg-[var(--vk-bg-hover)]"
                            >
                              {selectedAgentState.installed ? "Open setup" : "Open install guide"}
                            </button>
                          </>
                        ) : null}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>

                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-[29px] items-center gap-[4px] rounded-[3px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-[9px] py-[5px] text-[14px] leading-[21px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                      >
                        <span>{selectedPermission.label}</span>
                        <ChevronDown className="h-[10px] w-[10px] text-[var(--vk-text-muted)]" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="start" sideOffset={6} className={lightMenuClass}>
                        <p className="px-3 pb-1 text-[14px] font-semibold leading-[21px] text-[var(--vk-text-muted)]">Permissions</p>
                        {permissionOptions.map(({ id, label, icon: Icon }) => (
                          <DropdownMenu.Item
                            key={id}
                            onSelect={() => setPermissionMode(id)}
                            className={lightMenuItemClass}
                          >
                            <Icon className="h-4 w-4" />
                            <span>{label}</span>
                            <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                              {permissionMode === id ? <Check className="h-4 w-4" /> : null}
                            </span>
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>

                  <DropdownMenu.Root onOpenChange={setBranchMenuOpen}>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        disabled={!selectedProject}
                        className="inline-flex min-h-[29px] max-w-[320px] items-center justify-center truncate text-[14px] leading-[21px] text-[var(--vk-text-normal)] hover:text-[var(--vk-text-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {currentProjectLabel}
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="start"
                        side="bottom"
                        sideOffset={6}
                        avoidCollisions={false}
                        className={scrollMenuClass}
                      >
                        <p className="px-3 pb-1 text-[14px] font-semibold leading-[21px] text-[var(--vk-text-muted)]">Branch</p>
                        {selectedProjectLabel ? (
                          <p className="px-3 pb-2 text-[12px] leading-[16px] text-[var(--text-faint)]">
                            {selectedProjectLabel}
                          </p>
                        ) : null}
                        {branchLoading ? (
                          <div className="px-3 py-2 text-[14px] leading-[21px] text-[var(--vk-text-muted)]">Loading branches...</div>
                        ) : (
                          branchOptions.map((branch) => (
                            <DropdownMenu.Item
                              key={branch}
                              onSelect={() => setSelectedBranch(branch)}
                              className={lightMenuItemClass}
                            >
                              <span>{branch}</span>
                              <span className="ml-auto inline-flex h-4 w-4 items-center justify-center text-[var(--vk-text-strong)]">
                                {selectedBranch === branch ? <Check className="h-4 w-4" /> : null}
                              </span>
                            </DropdownMenu.Item>
                          ))
                        )}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>

                <div className="flex w-full justify-end sm:w-auto">
                  <button
                    type="button"
                    onClick={() => onCreate({
                      projectId: effectiveProjectId ?? undefined,
                      ...(useWorktree
                        ? { baseBranch: selectedBranch || selectedProject?.defaultBranch || undefined }
                        : { branch: selectedBranch || selectedProject?.defaultBranch || undefined }),
                      issueId: issueId.trim() || undefined,
                      useWorktree,
                      permissionMode,
                    })}
                    disabled={creating || !effectiveProjectId}
                    className="inline-flex min-h-[29px] items-center justify-center rounded-[3px] bg-[var(--vk-bg-hover)] px-[8px] py-[6.5px] text-[16px] leading-[16px] text-[var(--vk-text-strong)] transition-colors hover:bg-[var(--vk-bg-active)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Launch"}
                  </button>
                </div>
              </div>

              {selectedAgentState && !selectedAgentState.ready ? (
                <div className="rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-[13px] text-[var(--vk-text-strong)]">
                        {selectedAgentLabel} is not ready on this machine.
                      </p>
                      <p className="pt-0.5 text-[12px] text-[var(--vk-text-muted)]">
                        {selectedAgentState.installed
                          ? "Finish login or local setup to load models and start streaming sessions."
                          : "Install the CLI first, then its models and authentication state will appear here."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenAgentSetup(selectedAgent)}
                      className="inline-flex h-[29px] items-center justify-center rounded-[3px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-orange)] hover:bg-[var(--vk-bg-hover)]"
                    >
                      {selectedAgentState.installed ? "Open setup" : "Open install"}
                    </button>
                  </div>
                </div>
              ) : null}

              <label className="flex items-start gap-2 rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-2 py-2 text-[13px] text-[var(--vk-text-normal)]">
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(event) => setUseWorktree(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
                />
                <span>
                  Use worktree isolation
                  <span className="block text-[11px] text-[var(--vk-text-muted)]">
                    If unchecked, the session runs directly on the selected branch in the local repo.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </div>

        {error && <p className="pt-2 text-[12px] text-[var(--status-error)]">{error}</p>}
      </div>
    </section>
  );
});
