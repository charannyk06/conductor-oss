"use client";

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
import { type FormEvent, memo, useCallback, useEffect, useMemo, useState } from "react";
import type { IconType } from "react-icons";
import { SiNotion, SiObsidian } from "react-icons/si";
import { VscVscode } from "react-icons/vsc";
import {
  BookText,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronsRight,
  Copy,
  FolderGit2,
  FolderKanban,
  FolderOpen,
  Hand,
  List,
  Loader2,
  PlugZap,
  RefreshCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";
import { normalizeAgentName } from "@/lib/agentUtils";
import { getKnownAgent, KNOWN_AGENT_ORDER } from "@/lib/knownAgents";
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
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp))}`;
}

export type NewWorkspacePayload = {
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

export function NewWorkspaceDialog({
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
  const [projectIdTouched, setProjectIdTouched] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [path, setPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [agent, setAgent] = useState(defaultAgent);
  const [useWorktree, setUseWorktree] = useState(false);
  const [initializeGit, setInitializeGit] = useState(true);
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([]);
  const [githubReposLoading, setGithubReposLoading] = useState(false);
  const [githubReposLoaded, setGithubReposLoaded] = useState(false);
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
    setProjectIdTouched(false);
    setGitUrl("");
    setPath("");
    setDefaultBranch("main");
    setInitializeGit(true);
    setUseWorktree(false);
    setAgent(defaultAgent);
    setGithubRepos([]);
    setGithubReposLoaded(false);
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
    const query = githubRepoSearch.trim().toLowerCase();
    const filtered = query.length === 0 ? githubRepos : githubRepos.filter((repo) => {
      return repo.fullName.toLowerCase().includes(query)
        || repo.name.toLowerCase().includes(query)
        || (repo.ownerLogin ?? "").toLowerCase().includes(query)
        || (repo.description ?? "").toLowerCase().includes(query)
        || repo.defaultBranch.toLowerCase().includes(query);
    });
    return query.length === 0 ? filtered.slice(0, 10) : filtered.slice(0, 14);
  }, [githubRepoSearch, githubRepos]);

  const selectedGitHubRepoData = useMemo(() => {
    const selected = githubRepos.find((repo) => repo.httpsUrl === selectedGithubRepo);
    if (selected) return selected;
    if (!gitUrl.trim()) return null;
    return githubRepos.find((repo) => repo.httpsUrl === gitUrl.trim()) ?? null;
  }, [gitUrl, githubRepos, selectedGithubRepo]);

  const normalizedGitHubSearchUrl = useMemo(
    () => normalizeGitHubRepositoryUrl(githubRepoSearch),
    [githubRepoSearch],
  );
  const normalizedManualGitUrl = useMemo(
    () => normalizeManualGitUrl(githubRepoSearch),
    [githubRepoSearch],
  );
  const selectedRepoUpdatedLabel = useMemo(
    () => formatRepoUpdatedLabel(selectedGitHubRepoData?.updatedAt),
    [selectedGitHubRepoData],
  );
  const showUseSearchValueAction = useMemo(() => {
    const normalizedUrl = normalizedGitHubSearchUrl ?? normalizedManualGitUrl;
    if (!normalizedUrl) return false;
    return normalizedUrl.toLowerCase() !== gitUrl.trim().toLowerCase();
  }, [gitUrl, normalizedGitHubSearchUrl, normalizedManualGitUrl]);

  const orderedAgentOptions = useMemo(() => {
    const opts = [...new Set(agentOptions)];
    if (opts.length === 0) {
      opts.push(defaultAgent || DEFAULT_AGENT);
    }

    const rankMap = new Map(KNOWN_AGENT_ORDER.map((name, index) => [name, index]));
    return opts.sort((left, right) => {
      const leftRank = rankMap.get(normalizeAgentName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankMap.get(normalizeAgentName(right)) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return getAgentLabel(left).localeCompare(getAgentLabel(right));
    });
  }, [agentOptions, defaultAgent]);

  useEffect(() => {
    if (!orderedAgentOptions.includes(agent)) {
      setAgent(orderedAgentOptions[0] ?? DEFAULT_AGENT);
    }
  }, [agent, orderedAgentOptions]);

  const handleFetchGitHubRepos = async (forceRefresh = false) => {
    setGithubReposLoading(true);
    setGithubReposError(null);
    try {
      const query = forceRefresh ? "?refresh=true" : "";
      const res = await fetch(`/api/github/repos${query}`);
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
      setGithubReposLoaded(true);
      setGithubReposLoading(false);
    }
  };

  useEffect(() => {
    if (!open || mode !== "git") return;
    if (githubReposLoading || githubReposLoaded) return;
    void handleFetchGitHubRepos();
  }, [githubReposLoaded, githubReposLoading, mode, open]);

  const handleDetectBranches = async (
    sourceOverride?: { gitUrl?: string; path?: string },
  ) => {
    const effectiveGitUrl = sourceOverride?.gitUrl ?? (mode === "git" ? gitUrl.trim() : "");
    const effectivePath = sourceOverride?.path ?? (mode === "local" ? path.trim() : "");

    if (effectiveGitUrl.length === 0 && effectivePath.length === 0) {
      setBranchesError(
        mode === "git"
          ? "Choose or paste a repository first."
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
    setGithubRepoSearch(selected.fullName);
    setDefaultBranch(selected.defaultBranch || "main");
    if (!projectIdTouched) {
      const suggestedProjectId = suggestWorkspaceId(selected.name);
      setProjectId(suggestedProjectId || projectId);
    }

    await handleDetectBranches({ gitUrl: selected.httpsUrl });
  };

  const handleUseSearchValueAsRepository = async () => {
    const normalizedUrl = normalizedGitHubSearchUrl ?? normalizedManualGitUrl;
    if (!normalizedUrl) return;

    const matchingRepo = githubRepos.find((repo) => repo.httpsUrl.toLowerCase() === normalizedUrl.toLowerCase()) ?? null;
    if (matchingRepo) {
      await handleSelectGitHubRepo(matchingRepo.httpsUrl);
      return;
    }

    setSelectedGithubRepo("");
    setGitUrl(normalizedUrl);
    setDefaultBranch("main");
    setBranchOptions([]);
    setBranchesError(null);
    if (!projectIdTouched) {
      const repoName = extractRepositoryNameFromGitUrl(normalizedUrl);
      if (repoName) {
        setProjectId(suggestWorkspaceId(repoName));
      }
    }

    await handleDetectBranches({ gitUrl: normalizedUrl });
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
        className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/65 px-3 py-3 sm:items-center sm:py-0"
        onClick={() => {
          if (creating || folderPickerOpen) return;
          onClose();
        }}
        role="presentation"
      >
        <form
          onSubmit={handleSubmit}
          onClick={(event) => event.stopPropagation()}
          className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[760px] flex-col overflow-hidden rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        >
          <header className="flex items-center border-b border-[var(--vk-border)] px-4 py-3">
            <div>
              <h2 className="text-[18px] leading-[22px] text-[var(--vk-text-strong)]">Add Workspace</h2>
              <p className="pt-1 text-[12px] text-[var(--vk-text-muted)]">
                Pick a GitHub repository or local folder, then confirm the branch.
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

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
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
                GitHub
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

            {mode === "git" ? (
              <>
                <div className="rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-3">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-[5px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-strong)]">
                      <MarkGithubIcon className="h-[18px] w-[18px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-[var(--vk-text-strong)]">GitHub Repository</p>
                      <p className="pt-0.5 text-[12px] text-[var(--vk-text-muted)]">
                        Search accessible repositories or paste a repository URL. Conductor fills the branch and clone URL after selection.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setGithubReposLoaded(false);
                        void handleFetchGitHubRepos(true);
                      }}
                      disabled={githubReposLoading}
                      className="inline-flex h-8 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                    >
                      {githubReposLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <>
                          <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
                          Refresh
                        </>
                      )}
                    </button>
                  </div>

                  <div className="relative mt-3">
                    <MarkGithubIcon className="pointer-events-none absolute left-3 top-1/2 h-[16px] w-[16px] -translate-y-1/2 text-[var(--vk-text-muted)]" />
                    <input
                      value={githubRepoSearch}
                      onChange={(event) => setGithubRepoSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && showUseSearchValueAction) {
                          event.preventDefault();
                          void handleUseSearchValueAsRepository();
                        }
                      }}
                      placeholder="Search GitHub repos or paste a repository URL"
                      className="h-10 w-full rounded-[5px] border border-[var(--vk-border)] bg-transparent pl-10 pr-3 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                    />
                  </div>

                  {showUseSearchValueAction ? (
                    <button
                      type="button"
                      onClick={() => {
                        void handleUseSearchValueAsRepository();
                      }}
                      className="mt-3 inline-flex items-center gap-2 rounded-[5px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                    >
                      <RepoIcon className="h-4 w-4 text-[var(--vk-text-strong)]" />
                      <span className="truncate">
                        Use {normalizedGitHubSearchUrl ? "this GitHub repository" : "pasted repository URL"}
                      </span>
                    </button>
                  ) : null}

                  {githubReposLoading && githubRepos.length === 0 ? (
                    <div className="mt-3 rounded-[5px] border border-[var(--vk-border)] px-3 py-3 text-[12px] text-[var(--vk-text-muted)]">
                      Loading accessible GitHub repositories...
                    </div>
                  ) : null}

                  {githubReposError ? (
                    <div className="mt-3 rounded-[5px] border border-[var(--vk-red)]/40 bg-[var(--vk-bg-panel)] px-3 py-3 text-[12px] text-[var(--vk-red)]">
                      <p>{githubReposError}</p>
                      <button
                        type="button"
                        onClick={() => {
                          setGithubReposLoaded(false);
                          void handleFetchGitHubRepos(true);
                        }}
                        className="mt-2 inline-flex items-center rounded-[4px] border border-[var(--vk-border)] px-2 py-1 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                      >
                        Retry
                      </button>
                    </div>
                  ) : null}

                  {!githubReposError && filteredGitHubRepos.length > 0 ? (
                    <div className="mt-3 max-h-[260px] space-y-2 overflow-y-auto pr-1">
                      {filteredGitHubRepos.map((repo) => {
                        const repoUpdatedLabel = formatRepoUpdatedLabel(repo.updatedAt);
                        const selected = selectedGitHubRepoData?.httpsUrl === repo.httpsUrl;
                        return (
                          <button
                            key={repo.httpsUrl}
                            type="button"
                            onClick={() => {
                              void handleSelectGitHubRepo(repo.httpsUrl);
                            }}
                            className={`flex w-full items-start gap-3 rounded-[5px] border px-3 py-3 text-left transition ${
                              selected
                                ? "border-[var(--vk-orange)] bg-[var(--vk-bg-panel)]"
                                : "border-[var(--vk-border)] bg-[var(--vk-bg-panel)] hover:bg-[var(--vk-bg-hover)]"
                            }`}
                          >
                            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[var(--vk-text-strong)]">
                              <RepoIcon className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-[13px] font-medium text-[var(--vk-text-strong)]">
                                  {repo.fullName}
                                </span>
                                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--vk-border)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                                  {repo.private ? <LockIcon className="h-3 w-3" /> : <MarkGithubIcon className="h-3 w-3" />}
                                  {repo.private ? "Private" : "Public"}
                                </span>
                                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--vk-border)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                                  <GitBranchIcon className="h-3 w-3" />
                                  {repo.defaultBranch}
                                </span>
                              </span>
                              {repo.description ? (
                                <span className="mt-1 block line-clamp-2 text-[12px] leading-[17px] text-[var(--vk-text-muted)]">
                                  {repo.description}
                                </span>
                              ) : null}
                              <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--vk-text-muted)]">
                                {repo.ownerLogin ? <span>{repo.ownerLogin}</span> : null}
                                {repoUpdatedLabel ? <span>{repoUpdatedLabel}</span> : null}
                                {repo.permission ? <span>{repo.permission.toLowerCase()}</span> : null}
                              </span>
                            </span>
                            <span className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--vk-text-strong)]">
                              {selected ? <Check className="h-4 w-4" /> : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {!githubReposLoading && !githubReposError && filteredGitHubRepos.length === 0 ? (
                    <p className="mt-3 text-[12px] text-[var(--vk-text-muted)]">
                      {githubRepoSearch.trim().length > 0
                        ? "No matching repositories. Try another search or paste a repository URL."
                        : "No accessible GitHub repositories were found for this machine yet."}
                    </p>
                  ) : null}
                </div>

                {gitUrl.trim().length > 0 ? (
                  <div className="rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] p-3">
                    <div className="flex items-start gap-3">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-[5px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-strong)]">
                        <RepoIcon className="h-[18px] w-[18px]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-[var(--vk-text-strong)]">
                            {selectedGitHubRepoData?.fullName ?? gitUrl}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--vk-border)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                            {selectedGitHubRepoData ? (
                              selectedGitHubRepoData.private ? <LockIcon className="h-3 w-3" /> : <MarkGithubIcon className="h-3 w-3" />
                            ) : (
                              <MarkGithubIcon className="h-3 w-3" />
                            )}
                            {selectedGitHubRepoData ? (selectedGitHubRepoData.private ? "Private" : "Public") : "Manual URL"}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--vk-border)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                            <GitBranchIcon className="h-3 w-3" />
                            {defaultBranch || "main"}
                          </span>
                        </div>
                        {selectedGitHubRepoData?.description ? (
                          <p className="mt-1 line-clamp-2 text-[12px] leading-[17px] text-[var(--vk-text-muted)]">
                            {selectedGitHubRepoData.description}
                          </p>
                        ) : (
                          <p className="mt-1 truncate text-[12px] text-[var(--vk-text-muted)]">{gitUrl}</p>
                        )}
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--vk-text-muted)]">
                          {selectedGitHubRepoData?.ownerLogin ? <span>{selectedGitHubRepoData.ownerLogin}</span> : null}
                          {selectedRepoUpdatedLabel ? <span>{selectedRepoUpdatedLabel}</span> : null}
                          {selectedGitHubRepoData?.permission ? (
                            <span>{selectedGitHubRepoData.permission.toLowerCase()}</span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
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

            <label className="block">
              <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Workspace Name (optional)</span>
              <input
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setProjectIdTouched(true);
                }}
                placeholder="auto-derived from the selected repository or folder"
                className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
              />
            </label>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">Branch</span>
                <div className="flex items-center gap-2">
                  <input
                    value={defaultBranch}
                    onChange={(event) => setDefaultBranch(event.target.value)}
                    placeholder="Uses the repository default branch"
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

            {mode === "git" ? (
              <details className="rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)]">
                <summary className="cursor-pointer list-none px-3 py-2 text-[13px] text-[var(--vk-text-normal)] marker:hidden">
                  <span className="inline-flex items-center gap-2">
                    <ChevronDown className="h-3.5 w-3.5 text-[var(--vk-text-muted)]" />
                    Advanced options
                  </span>
                </summary>
                <div className="space-y-3 border-t border-[var(--vk-border)] px-3 py-3">
                  <label className="block">
                    <span className="mb-1.5 block text-[12px] text-[var(--vk-text-muted)]">
                      Local Copy Location (optional)
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        value={path}
                        readOnly
                        onClick={() => openFolderPicker("clone")}
                        placeholder="Choose a folder only if you want a specific clone location"
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

                  <label className="flex items-start gap-2 rounded-[4px] border border-[var(--vk-border)] px-2 py-2 text-[13px] text-[var(--vk-text-normal)]">
                    <input
                      type="checkbox"
                      checked={useWorktree}
                      onChange={(event) => setUseWorktree(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
                    />
                    <span>
                      Keep work isolated in a new worktree
                      <span className="block text-[11px] text-[var(--vk-text-muted)]">
                        Turn this off only if you want sessions to run directly in the selected branch.
                      </span>
                    </span>
                  </label>
                </div>
              </details>
            ) : (
              <label className="flex items-start gap-2 rounded-[4px] border border-[var(--vk-border)] px-2 py-2 text-[13px] text-[var(--vk-text-normal)]">
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(event) => setUseWorktree(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
                />
                <span>
                  Keep work isolated in a new worktree
                  <span className="block text-[11px] text-[var(--vk-text-muted)]">
                    Turn this off only if you want sessions to run directly in the selected branch.
                  </span>
                </span>
              </label>
            )}

            {error && <p className="text-[12px] text-[var(--vk-red)]">{error}</p>}
          </div>

          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--vk-border)] px-4 py-3">
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
          if ((mode === "local" || folderPickerTarget === "local") && !projectIdTouched) {
            const folderName = extractNameFromPath(selectedPath);
            if (folderName) {
              setProjectId(suggestWorkspaceId(folderName));
            }
          }
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
  const [browseLoading, setBrowseLoading] = useState(false);

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
    // Handle Windows drive root (e.g. "C:/")
    if (/^[A-Za-z]:\/?$/.test(currentPath)) return;
    if (normalized === "/") return;
    const parts = normalized.split("/").filter(Boolean);
    // Preserve Windows drive letter when going up
    const driveMatch = currentPath.match(/^([A-Za-z]):[/\\]/);
    const parent = driveMatch
      ? parts.length > 1 ? `${driveMatch[1]}:/${parts.slice(1, -1).join("/")}` : `${driveMatch[1]}:/`
      : parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/";
    void loadDirectory(parent);
  };

  const handleNativeBrowse = async () => {
    setBrowseLoading(true);
    try {
      const res = await fetch("/api/filesystem/pick-directory", { method: "POST" });
      const data = (await res.json().catch(() => null)) as
        | { path?: string; cancelled?: boolean; error?: string }
        | null;
      if (!data || data.cancelled || !data.path) return;
      setManualPath(data.path);
      void loadDirectory(data.path);
    } catch {
      // Native picker unavailable — user can still use manual path entry
    } finally {
      setBrowseLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center overflow-y-auto bg-black/70 px-3 py-3 sm:items-center sm:py-0"
      onClick={() => {
        onClose();
        onSelect(null);
      }}
      role="presentation"
    >
      <div
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[760px] flex-col overflow-hidden rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b border-[var(--vk-border)] px-4 py-3">
          <h3 className="text-[16px] text-[var(--vk-text-strong)]">{title}</h3>
          <p className="pt-1 text-[12px] text-[var(--vk-text-muted)]">{description}</p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
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

          <div className="flex flex-wrap items-center gap-2">
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
            <button
              type="button"
              disabled={browseLoading}
              onClick={() => { void handleNativeBrowse(); }}
              className="inline-flex h-8 items-center gap-1 rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
            >
              {browseLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
              {browseLoading ? "Opening..." : "Browse"}
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


function CopySnippetButton({
  value,
  idleLabel = "Copy",
  copiedLabel = "Copied",
}: {
  value: string;
  idleLabel?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[var(--vk-orange)]" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? copiedLabel : idleLabel}</span>
    </button>
  );
}

export function SettingsDialog({
  open,
  mode,
  creating,
  error,
  current,
  projectCount,
  agentOptions,
  agentStates,
  runtimeModelCatalogs,
  onRepositoriesChanged,
  onOnboardingComplete,
  onOpenAgentSetup,
  onClose,
  onSave,
}: {
  open: boolean;
  mode: PreferencesDialogMode;
  creating: boolean;
  error: string | null;
  current: PreferencesPayload;
  projectCount: number;
  agentOptions: string[];
  agentStates: Record<string, AgentSetupState>;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  onRepositoriesChanged?: () => Promise<void>;
  onOnboardingComplete?: (result: { needsProject: boolean }) => void;
  onOpenAgentSetup: (agent: string) => void;
  onClose: () => void;
  onSave: (next: PreferencesPayload, options?: { closeDialog?: boolean }) => Promise<boolean>;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("preferences");
  const [codingAgent, setCodingAgent] = useState(current.codingAgent);
  const [ide, setIde] = useState(current.ide);
  const [markdownEditor, setMarkdownEditor] = useState(current.markdownEditor);
  const [markdownEditorPath, setMarkdownEditorPath] = useState<string>(current.markdownEditorPath ?? "");
  const [modelAccess, setModelAccess] = useState<ModelAccessPreferences>(current.modelAccess);
  const [soundEnabled, setSoundEnabled] = useState(current.notifications.soundEnabled);
  const [soundFile, setSoundFile] = useState<string | null>(current.notifications.soundFile);
  const [repositories, setRepositories] = useState<RepositorySettingsPayload[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesSaving, setRepositoriesSaving] = useState(false);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [repositoryDraft, setRepositoryDraft] = useState<RepositorySettingsPayload | null>(null);
  const [repositoryModelSelection, setRepositoryModelSelection] = useState<ModelSelectionState>(emptyModelSelection());
  const [repositoryBranchOptions, setRepositoryBranchOptions] = useState<string[]>([]);
  const [repositoryBranchesLoading, setRepositoryBranchesLoading] = useState(false);
  const [repositoryBranchesError, setRepositoryBranchesError] = useState<string | null>(null);
  const [repositoryFolderPickerOpen, setRepositoryFolderPickerOpen] = useState(false);
  const [notesFolderPickerOpen, setNotesFolderPickerOpen] = useState(false);
  const [accessSettings, setAccessSettings] = useState<AccessSettingsPayload>(() => normalizeAccessSettings(null));
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [remoteAccessSettings, setRemoteAccessSettings] = useState<RemoteAccessPayload>(() => normalizeRemoteAccess(null));
  const [remoteAccessLoading, setRemoteAccessLoading] = useState(false);
  const [remoteAccessMutating, setRemoteAccessMutating] = useState<RemoteAccessAction | null>(null);
  const [remoteAccessError, setRemoteAccessError] = useState<string | null>(null);

  const isBusy = creating || repositoriesSaving || accessSaving || remoteAccessMutating !== null;

function hydrateRepositoryDraft(value: RepositorySettingsPayload): RepositorySettingsPayload {
  return {
    ...value,
    agentPermissions: value.agentPermissions === "default" ? "default" : "skip",
    devServerScript: value.devServerScript ?? "",
    devServerCwd: value.devServerCwd ?? "",
    devServerUrl: value.devServerUrl ?? "",
    devServerPort: value.devServerPort ?? "",
    devServerHost: value.devServerHost ?? "",
    devServerPath: value.devServerPath ?? "",
    devServerHttps: value.devServerHttps === true,
    pathHealth: {
      exists: value.pathHealth.exists,
      isGitRepository: value.pathHealth.isGitRepository,
      suggestedPath: value.pathHealth.suggestedPath,
    },
  };
}

  function parseMultilineRoleList(value: string): string[] {
    return value
      .split(/\n+/g)
      .map((item) => item.trim())
      .filter(Boolean);
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
      setRepositoryModelSelection(emptyModelSelection());
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

  async function handleSaveRepository(): Promise<boolean> {
    if (!repositoryDraft || repositoriesSaving) return false;
    if (repositoryDraft.repo.trim().length === 0 || repositoryDraft.path.trim().length === 0) return false;

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
          agent: repositoryDraft.agent,
          agentPermissions: repositoryDraft.agentPermissions,
          agentModel: resolveModelSelectionValue(repositoryModelSelection) ?? "",
          agentReasoningEffort: resolveReasoningSelectionValue(repositoryModelSelection) ?? "",
          defaultWorkingDirectory: repositoryDraft.defaultWorkingDirectory,
          defaultBranch: repositoryDraft.defaultBranch,
          devServerScript: repositoryDraft.devServerScript,
          devServerCwd: repositoryDraft.devServerCwd,
          devServerUrl: repositoryDraft.devServerUrl,
          devServerPort: repositoryDraft.devServerPort,
          devServerHost: repositoryDraft.devServerHost,
          devServerPath: repositoryDraft.devServerPath,
          devServerHttps: repositoryDraft.devServerHttps,
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
      return true;
    } catch (err) {
      setRepositoriesError(err instanceof Error ? err.message : "Failed to save repository settings");
      return false;
    } finally {
      setRepositoriesSaving(false);
    }
  }

  async function loadAccessSettings(): Promise<void> {
    setAccessLoading(true);
    setAccessError(null);
    try {
      const res = await fetch("/api/access");
      const data = (await res.json().catch(() => null)) as
        | { access?: unknown; current?: unknown; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to load organization settings (${res.status})`);
      }
      setAccessSettings(normalizeAccessSettings(data?.access, data?.current));
    } catch (err) {
      setAccessSettings(normalizeAccessSettings(null));
      setAccessError(err instanceof Error ? err.message : "Failed to load organization settings");
    } finally {
      setAccessLoading(false);
    }
  }

  async function handleSaveAccess(): Promise<boolean> {
    if (accessSaving) return false;

    setAccessSaving(true);
    setAccessError(null);
    try {
      const res = await fetch("/api/access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requireAuth: accessSettings.requireAuth || accessSettings.trustedHeaders.enabled,
          defaultRole: accessSettings.defaultRole,
          trustedHeaders: {
            enabled: accessSettings.trustedHeaders.enabled,
            provider: "cloudflare-access",
            emailHeader: accessSettings.trustedHeaders.emailHeader,
            jwtHeader: accessSettings.trustedHeaders.jwtHeader,
            teamDomain: accessSettings.trustedHeaders.teamDomain,
            audience: accessSettings.trustedHeaders.audience,
          },
          roles: {
            viewers: parseMultilineRoleList(accessSettings.roles.viewers),
            operators: parseMultilineRoleList(accessSettings.roles.operators),
            admins: parseMultilineRoleList(accessSettings.roles.admins),
            viewerDomains: parseMultilineRoleList(accessSettings.roles.viewerDomains),
            operatorDomains: parseMultilineRoleList(accessSettings.roles.operatorDomains),
            adminDomains: parseMultilineRoleList(accessSettings.roles.adminDomains),
          },
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { access?: unknown; current?: unknown; error?: string }
        | null;
      if (!res.ok) {
        throw new Error(data?.error ?? `Failed to save organization settings (${res.status})`);
      }

      setAccessSettings(normalizeAccessSettings(data?.access, data?.current));
      if (activeTab === "remote_access") {
        await loadRemoteAccess();
      }
      return true;
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : "Failed to save organization settings");
      return false;
    } finally {
      setAccessSaving(false);
    }
  }

  async function loadRemoteAccess(): Promise<void> {
    setRemoteAccessLoading(true);
    setRemoteAccessError(null);
    try {
      const res = await fetch("/api/remote-access");
      const data = (await res.json().catch(() => null)) as
        | { error?: string; reason?: string }
        | RemoteAccessPayload
        | null;
      if (!res.ok) {
        const reason = data && typeof data === "object" && "reason" in data && typeof data.reason === "string"
          ? data.reason
          : null;
        const errorMessage = data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : null;
        throw new Error(reason ?? errorMessage ?? `Failed to load remote access (${res.status})`);
      }

      setRemoteAccessSettings(normalizeRemoteAccess(data));
    } catch (err) {
      setRemoteAccessSettings(normalizeRemoteAccess(null));
      setRemoteAccessError(err instanceof Error ? err.message : "Failed to load remote access");
    } finally {
      setRemoteAccessLoading(false);
    }
  }

  async function mutateRemoteAccess(action: RemoteAccessAction): Promise<void> {
    setRemoteAccessMutating(action);
    setRemoteAccessError(null);
    try {
      const res = await fetch("/api/remote-access", {
        method: action === "disable" ? "DELETE" : "POST",
        headers: action === "disable"
          ? undefined
          : {
              "Content-Type": "application/json",
            },
        body: action === "disable"
          ? undefined
          : JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; reason?: string }
        | RemoteAccessPayload
        | null;
      if (!res.ok) {
        const reason = data && typeof data === "object" && "reason" in data && typeof data.reason === "string"
          ? data.reason
          : null;
        const errorMessage = data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : null;
        throw new Error(reason ?? errorMessage ?? `Failed to ${action} remote access (${res.status})`);
      }

      setRemoteAccessSettings(normalizeRemoteAccess(data));
    } catch (err) {
      setRemoteAccessError(err instanceof Error ? err.message : `Failed to ${action} remote access`);
    } finally {
      setRemoteAccessMutating(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    setActiveTab(mode === "onboarding" ? "preferences" : "general");
    setCodingAgent(current.codingAgent);
    setIde(current.ide);
    setMarkdownEditor(current.markdownEditor);
    setMarkdownEditorPath(current.markdownEditorPath ?? "");
    setModelAccess(current.modelAccess);
    setSoundEnabled(current.notifications.soundEnabled);
    setSoundFile(current.notifications.soundFile);
    setRepositoryBranchOptions([]);
    setRepositoryBranchesError(null);
    setRepositoriesError(null);
    setRepositoryModelSelection(emptyModelSelection());
    setAccessError(null);
    setRemoteAccessSettings(normalizeRemoteAccess(null));
    setRemoteAccessError(null);
  }, [mode, open]);

  useEffect(() => {
    if (!open) return;
    if (mode === "settings" || activeTab === "repositories") {
      void loadRepositories();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, mode, open]);

  useEffect(() => {
    if (!open || mode === "onboarding") return;
    void loadAccessSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, open]);

  useEffect(() => {
    if (!open || mode === "onboarding" || activeTab !== "remote_access") return;
    void loadRemoteAccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, mode, open]);

  useEffect(() => {
    if (!open) return;
    if (!selectedRepositoryId) {
      setRepositoryDraft(null);
      setRepositoryModelSelection(emptyModelSelection());
      return;
    }
    const selected = repositories.find((item) => item.id === selectedRepositoryId);
    if (!selected) return;
    setRepositoryDraft(hydrateRepositoryDraft(selected));
    setRepositoryModelSelection(
      buildModelSelection(
        selected.agent,
        modelAccess,
        runtimeModelCatalogs,
        selected.agentModel,
        selected.agentReasoningEffort,
      ),
    );
    setRepositoryBranchOptions([]);
    setRepositoryBranchesError(null);
    if (selected.path.trim().length > 0) {
      void detectRepositoryBranches(selected.path, selected.defaultBranch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelAccess, open, repositories, runtimeModelCatalogs, selectedRepositoryId]);

  const onboardingShouldShowRepositoryStep = mode === "onboarding" && projectCount > 0;

  const visibleTabs = useMemo(() => {
    if (mode === "onboarding") {
      return onboardingShouldShowRepositoryStep
        ? ONBOARDING_TABS
        : ONBOARDING_TABS.filter((tab) => tab.id === "preferences");
    }
    return SETTINGS_TABS.filter((tab) => tab.implemented);
  }, [mode, onboardingShouldShowRepositoryStep]);

  const activeTabItem = visibleTabs.find((tab) => tab.id === activeTab) ?? visibleTabs[0] ?? SETTINGS_TABS[0];
  const isOnboarding = mode === "onboarding";
  const isPreferencesTab = activeTabItem.id === "preferences";
  const isGeneralTab = activeTabItem.id === "general";
  const isRemoteAccessTab = activeTabItem.id === "remote_access";
  const isAgentsTab = activeTabItem.id === "agents";
  const isPreferenceFormTab = isPreferencesTab || isGeneralTab || isAgentsTab;
  const isPrimarySettingsTab = isPreferenceFormTab || isRemoteAccessTab;
  const isRepositoriesTab = activeTabItem.id === "repositories";
  const isOrganizationTab = activeTabItem.id === "organization";
  const onboardingStepIndex = visibleTabs.findIndex((tab) => tab.id === activeTabItem.id) + 1;
  const onboardingHasRepositoryStep = visibleTabs.some((tab) => tab.id === "repositories");
  const accessCanEdit = accessSettings.current.role === "admin";
  const remoteAccessModeLabel = getRemoteAccessModeLabel(remoteAccessSettings.mode);
  const remoteAccessStatusLabel = getRemoteAccessStatusLabel(remoteAccessSettings.status);
  const remoteAccessMutationPending = remoteAccessMutating !== null;
  const managedRemoteProvider = remoteAccessSettings.provider ?? remoteAccessSettings.recommendedProvider;
  const usingPrivateNetworkFlow = managedRemoteProvider === "tailscale";
  const showManagedTunnelControls = managedRemoteProvider !== null || remoteAccessSettings.managed;
  const selectedIdeOption = resolveIdeOption(ide);
  const settingsMenuClass = "z-50 min-w-[240px] rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.35)]";
  const settingsSubMenuClass = `${settingsMenuClass} min-w-[280px]`;
  const settingsMenuItemClass = "flex min-h-[40px] cursor-default items-center gap-2 rounded-[4px] px-3 py-2 text-[14px] leading-[21px] text-[var(--vk-text-normal)] outline-none hover:bg-[var(--vk-bg-hover)] focus:bg-[var(--vk-bg-hover)]";
  const remoteAccessEnableLabel = !remoteAccessSettings.installed && remoteAccessSettings.canAutoInstall
    ? "Install + Enable"
    : "Enable Private Link";
  const remoteAccessCanEnable = !remoteAccessLoading
    && !remoteAccessMutationPending
    && usingPrivateNetworkFlow
    && !(remoteAccessSettings.status === "ready" && remoteAccessSettings.managed);
  const remoteAccessCanRotate = false;
  const remoteAccessCanDisable = !remoteAccessLoading
    && !remoteAccessMutationPending
    && (remoteAccessSettings.status === "starting" || remoteAccessSettings.status === "ready" || remoteAccessSettings.status === "error");

  const orderedAgentOptions = useMemo(() => {
    const opts = new Set(agentOptions);
    if (codingAgent.trim().length > 0) {
      opts.add(codingAgent);
    }
    if (opts.size === 0) {
      opts.add(DEFAULT_AGENT);
    }
    const rankMap = new Map(KNOWN_AGENT_ORDER.map((name, index) => [name, index]));
    return [...opts].sort((left, right) => {
      const leftRank = rankMap.get(normalizeAgentName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankMap.get(normalizeAgentName(right)) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return getAgentLabel(left).localeCompare(getAgentLabel(right));
    });
  }, [agentOptions, codingAgent]);
  const selectedCodingAgentState = agentStates[normalizeAgentName(codingAgent)] ?? null;

  function handleModelAccessChange(agent: string, nextAccess: string) {
    const catalog = getAgentModelCatalog(agent);
    if (!catalog) return;

    setModelAccess((prev) => ({
      ...prev,
      [catalog.accessKey]: nextAccess,
    } as ModelAccessPreferences));
  }

  if (!open) return null;

  const canSubmitPreferences = codingAgent.trim().length > 0
    && ide.trim().length > 0
    && markdownEditor.trim().length > 0;
  const canSaveRepository = !!repositoryDraft
    && repositoryDraft.displayName.trim().length > 0
    && repositoryDraft.repo.trim().length > 0
    && repositoryDraft.path.trim().length > 0
    && repositoryDraft.defaultBranch.trim().length > 0;
  const canSaveAccess = accessCanEdit && !accessLoading && (
    !accessSettings.trustedHeaders.enabled
    || (
      accessSettings.trustedHeaders.teamDomain.trim().length > 0
      && accessSettings.trustedHeaders.audience.trim().length > 0
    )
  );
  const dialogError = isRepositoriesTab
    ? repositoriesError
    : isOrganizationTab
      ? accessError
      : error;
  const accessRoleFields: Array<{
    label: string;
    key: keyof AccessSettingsPayload["roles"];
    placeholder: string;
  }> = [
    { label: "Viewer Emails", key: "viewers", placeholder: "alice@example.com" },
    { label: "Operator Emails", key: "operators", placeholder: "builder@example.com" },
    { label: "Admin Emails", key: "admins", placeholder: "owner@example.com" },
    { label: "Viewer Domains", key: "viewerDomains", placeholder: "guests.example.com" },
    { label: "Operator Domains", key: "operatorDomains", placeholder: "eng.example.com" },
    { label: "Admin Domains", key: "adminDomains", placeholder: "admins.example.com" },
  ];
  const repositoryBootstrapCommand = repositoryDraft
    ? buildRepositoryBootstrapCommand({
        ...repositoryDraft,
        agentModel: resolveModelSelectionValue(repositoryModelSelection) ?? "",
        agentReasoningEffort: resolveReasoningSelectionValue(repositoryModelSelection) ?? "",
      }, {
        ide,
        markdownEditor,
      })
    : "";

  function buildNextPreferences(acknowledgeOnboarding: boolean): PreferencesPayload {
    const resolvedSoundFile = soundEnabled
      ? soundFile ?? NOTIFICATION_SOUND_OPTIONS[0]?.id ?? "abstract-sound-4"
      : null;

    return {
      onboardingAcknowledged: acknowledgeOnboarding ? true : current.onboardingAcknowledged,
      codingAgent: codingAgent.trim(),
      ide: ide.trim(),
      markdownEditor: markdownEditor.trim(),
      markdownEditorPath: (markdownEditorPath ?? "").trim(),
      modelAccess,
      notifications: {
        soundEnabled,
        soundFile: resolvedSoundFile,
      },
    };
  }

  async function handleSubmitPreferences(
    acknowledgeOnboarding: boolean,
    options?: { closeDialog?: boolean },
  ): Promise<boolean> {
    if (!canSubmitPreferences || creating) return false;
    const saved = await onSave(buildNextPreferences(acknowledgeOnboarding), options);
    if (saved && selectedCodingAgentState && !selectedCodingAgentState.ready) {
      onOpenAgentSetup(codingAgent);
    }
    return saved;
  }

  async function handleOnboardingContinue() {
    if (repositoriesLoading) return;
    if (!onboardingHasRepositoryStep) {
      const saved = await handleSubmitPreferences(true, { closeDialog: true });
      if (!saved) return;
      onOnboardingComplete?.({ needsProject: projectCount === 0 });
      return;
    }

    const saved = await handleSubmitPreferences(false, { closeDialog: false });
    if (!saved) return;
    setActiveTab("repositories");
  }

  async function handleFinishOnboarding() {
    if (isRepositoriesTab) {
      const saved = await handleSaveRepository();
      if (!saved) return;
    }

    const saved = await handleSubmitPreferences(true, { closeDialog: true });
    if (!saved) return;
    onOnboardingComplete?.({ needsProject: false });
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-black/70 px-3 py-3 sm:items-center"
        onClick={() => {
          if (isBusy || mode === "onboarding" || repositoryFolderPickerOpen || notesFolderPickerOpen) return;
          onClose();
        }}
        role="presentation"
      >
        <div
          className="flex h-[100dvh] w-full flex-col overflow-hidden border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_24px_80px_rgba(0,0,0,0.55)] sm:h-[min(92vh,760px)] sm:max-h-[calc(100dvh-1.5rem)] sm:max-w-[1120px] sm:rounded-[6px] sm:border sm:flex-row"
          onClick={(event) => event.stopPropagation()}
        >
          <aside className="flex w-full shrink-0 flex-col border-b border-[var(--vk-border)] bg-[rgba(28,28,28,0.8)] sm:w-[224px] sm:border-b-0 sm:border-r">
            <header className="border-b border-[var(--vk-border)] px-4 py-3 sm:py-4">
              <h2 className="text-[22px] leading-[24px] text-[var(--vk-text-strong)] sm:text-[27px] sm:leading-[27px]">
                {isOnboarding ? "Setup" : "Settings"}
              </h2>
            </header>
            <nav className="-mx-0.5 flex gap-1 overflow-x-auto px-2 py-2 sm:mx-0 sm:block sm:space-y-1 sm:overflow-auto sm:px-2">
              {visibleTabs.map((tab) => {
                const Icon = tab.icon;
                const selected = activeTabItem.id === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    disabled={isBusy}
                    className={`flex min-h-[44px] shrink-0 items-center gap-3 rounded-[3px] px-3 py-2 text-left text-[14px] leading-[21px] transition-colors sm:min-h-0 sm:w-full ${
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
            <header className="flex items-center justify-between border-b border-[var(--vk-border)] px-4 py-3 sm:py-4">
              <div>
                <h3 className="text-[20px] leading-[24px] text-[var(--vk-text-strong)] sm:text-[27px] sm:leading-[27px]">
                  {isOnboarding
                    ? isPreferencesTab
                      ? "Choose your preferences"
                      : "Review repository defaults"
                    : activeTabItem.label}
                </h3>
                {isOnboarding && (
                  <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                    Step {onboardingStepIndex} of {visibleTabs.length}
                  </p>
                )}
              </div>
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

            <div className="min-h-0 flex-1 overflow-auto px-4 py-3 sm:px-6 sm:py-4">
              {isPrimarySettingsTab ? (
                <div className="space-y-5">
                  {isOnboarding && (
                    <section className="rounded-[6px] border border-[var(--vk-border)] bg-[rgba(234,122,42,0.08)] px-4 py-3">
                      <p className="text-[13px] leading-5 text-[var(--vk-text-normal)]">
                        Conductor is already running locally. Finish setup here in the dashboard, then you can start using
                        chat and boards immediately.
                      </p>
                    </section>
                  )}

                  {(isPreferencesTab || isAgentsTab) && (
                    <>
                  <section className="space-y-2">
                    <h4 className="text-[15px] font-medium text-[var(--vk-text-strong)]">Choose Your Coding Agent</h4>
                    <p className="text-[12px] text-[var(--vk-text-muted)]">
                      Select the default coding agent, review its setup state, and confirm which models Conductor can offer for it.
                    </p>
                    <div className="grid gap-3">
                      {orderedAgentOptions.map((agent) => {
                        const selected = codingAgent === agent;
                        const agentState = agentStates[normalizeAgentName(agent)] ?? null;
                        const accessLabel = getAgentModelAccessLabel(agent, modelAccess);
                        const availableModels = getSelectableAgentModels(agent, modelAccess, runtimeModelCatalogs);
                        const previewModels = availableModels.slice(0, 3);
                        const additionalModels = availableModels.length - previewModels.length;
                        const statusLabel = !agentState?.installed
                          ? "Not installed"
                          : !agentState.ready
                            ? "Setup required"
                            : "Ready";
                        return (
                          <div
                            key={agent}
                            className={`flex flex-col gap-3 rounded-[4px] border px-3 py-3 text-left sm:flex-row sm:items-start ${
                              selected
                                ? "border-[var(--vk-orange)] bg-[var(--vk-bg-hover)]"
                                : "border-[var(--vk-border)] hover:bg-[var(--vk-bg-hover)]"
                            }`}
                          >
                            <div className="flex min-w-0 flex-1 items-start gap-3">
                              <AgentTileIcon seed={{ label: agent }} className="mt-0.5 h-5 w-5 border-none bg-transparent" />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[13px] font-medium text-[var(--vk-text-normal)]">{getAgentLabel(agent)}</span>
                                  <span className="inline-flex rounded-full border border-[var(--vk-border)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                                    {statusLabel}
                                  </span>
                                  {accessLabel ? (
                                    <span className="inline-flex rounded-full border border-[var(--vk-border)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                                      {accessLabel}
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                                  {agentState?.description ?? getKnownAgent(agent)?.description ?? "Agent metadata not available."}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {previewModels.map((model) => (
                                    <span
                                      key={`${agent}-${model.id}`}
                                      className="inline-flex rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 py-0.5 text-[11px] text-[var(--vk-text-normal)]"
                                    >
                                      {model.label}
                                    </span>
                                  ))}
                                  {additionalModels > 0 ? (
                                    <span className="inline-flex rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                                      +{additionalModels} more
                                    </span>
                                  ) : null}
                                  {previewModels.length === 0 ? (
                                    <span className="inline-flex rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
                                      {supportsAgentModelSelection(agent) ? "Models appear after setup" : "Uses the agent default model"}
                                    </span>
                                  ) : null}
                                </div>
                                {!agentState?.installed && agentState?.installHint ? (
                                  <p className="mt-2 text-[11px] text-[var(--vk-text-muted)]">
                                    Install hint: <code className="rounded bg-[var(--vk-bg-main)] px-1.5 py-0.5 text-[11px] text-[var(--vk-text-normal)]">{agentState.installHint}</code>
                                  </p>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 self-start sm:ml-auto">
                              {!agentState?.ready ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCodingAgent(agent);
                                    onOpenAgentSetup(agent);
                                  }}
                                  className="inline-flex h-8 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-orange)] hover:bg-[var(--vk-bg-panel)]"
                                >
                                  {agentState?.installed ? "Authenticate" : "Install"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => setCodingAgent(agent)}
                                className={`inline-flex h-8 items-center rounded-[4px] border px-3 text-[12px] ${
                                  selected
                                    ? "border-[var(--vk-orange)] bg-[var(--vk-orange)]/12 text-[var(--vk-orange)]"
                                    : "border-[var(--vk-border)] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-panel)]"
                                }`}
                              >
                                {selected ? "Selected" : "Use this agent"}
                              </button>
                              {selected && <Check className="h-3.5 w-3.5 text-[var(--vk-orange)]" />}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  <section className="space-y-3">
                    <div className="space-y-1">
                      <h4 className="text-[15px] font-medium text-[var(--vk-text-strong)]">Model Access</h4>
                      <p className="text-[12px] text-[var(--vk-text-muted)]">
                        Tell Conductor which account mode each agent is using so the model dropdown only shows options
                        that make sense for that login path.
                      </p>
                    </div>
                    <div className="grid gap-3">
                      {orderedAgentOptions.filter((agent) => {
                        const catalog = getAgentModelCatalog(agent);
                        return supportsAgentModelSelection(agent) && (catalog?.accessOptions.length ?? 0) > 1;
                      }).map((agent) => {
                        const catalog = getAgentModelCatalog(agent);
                        if (!catalog) return null;
                        const selectedAccess = resolveAgentModelAccess(agent, modelAccess) ?? catalog.defaultAccess;
                        return (
                          <label key={agent} className="block rounded-[4px] border border-[var(--vk-border)] px-3 py-3">
                            <span className="mb-1 block text-[13px] font-medium text-[var(--vk-text-normal)]">
                              {catalog.label}
                            </span>
                            <select
                              value={selectedAccess}
                              onChange={(event) => handleModelAccessChange(agent, event.target.value)}
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            >
                              {catalog.accessOptions.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <p className="mt-1.5 text-[11px] text-[var(--vk-text-muted)]">
                              {catalog.accessOptions.find((option) => option.id === selectedAccess)?.description}
                            </p>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                    </>
                  )}

                  {(isPreferencesTab || isGeneralTab) && (
                    <>
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
                        {markdownEditor !== "notion" && (
                          <div className="rounded-[4px] border border-[var(--vk-border)] px-3 py-3">
                            <label className="block">
                              <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">
                                Notes Root
                              </span>
                              <div className="flex items-center gap-2">
                                <input
                                  value={markdownEditorPath ?? ""}
                                  readOnly
                                  onClick={() => setNotesFolderPickerOpen(true)}
                                  placeholder="Select your Obsidian vault, Logseq graph, or notes folder"
                                  className="h-9 w-full cursor-pointer rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                                />
                                <button
                                  type="button"
                                  onClick={() => setNotesFolderPickerOpen(true)}
                                  disabled={isBusy}
                                  className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
                                  title="Browse folders"
                                >
                                  <FolderOpen className="h-4 w-4" />
                                </button>
                                {(markdownEditorPath ?? "").trim().length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => setMarkdownEditorPath("")}
                                    disabled={isBusy}
                                    className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                              <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                                Context attachments are discovered from this folder first. Leave it blank to fall back to the current workspace.
                              </p>
                            </label>
                          </div>
                        )}
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
                    </>
                  )}

                  {isRemoteAccessTab && (
                    <div className="space-y-4">
                      <section className="rounded-[6px] border border-[var(--vk-border)] bg-[rgba(234,122,42,0.06)] px-4 py-3">
                        <h4 className="text-[15px] font-medium text-[var(--vk-text-strong)]">Remote Access</h4>
                        <p className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                          Use one complete URL to open this Conductor instance from your phone or any other machine.
                          The URL below is only shown to admin sessions because it can grant real control of the dashboard.
                        </p>
                      </section>

                    <section className="space-y-3 rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <h5 className="text-[18px] leading-[20px] text-[var(--vk-text-strong)]">{remoteAccessSettings.title}</h5>
                          <p className="text-[12px] leading-5 text-[var(--vk-text-muted)]">
                            {remoteAccessSettings.description}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void loadRemoteAccess()}
                          disabled={remoteAccessLoading}
                          className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--vk-border)] px-2 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <RefreshCcw className={`h-3.5 w-3.5${remoteAccessLoading ? " animate-spin" : ""}`} />
                          <span>Refresh</span>
                        </button>
                      </div>

                      {remoteAccessLoading ? (
                        <div className="flex items-center gap-2 rounded-[6px] border border-[var(--vk-border)] px-3 py-3 text-[13px] text-[var(--vk-text-muted)]">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading remote access details...
                        </div>
                      ) : remoteAccessError ? (
                        <div className="rounded-[6px] border border-[var(--vk-red)]/35 bg-[var(--vk-red)]/10 px-3 py-3 text-[12px] leading-5 text-[var(--vk-red)]">
                          {remoteAccessError}
                        </div>
                      ) : (
                        <>
                          <div className="grid gap-3 lg:grid-cols-3">
                            <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                                Remote Status
                              </span>
                              <p className="mt-2 text-[14px] text-[var(--vk-text-normal)]">{remoteAccessStatusLabel}</p>
                            </div>
                            <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                                Security Mode
                              </span>
                              <p className="mt-2 text-[14px] text-[var(--vk-text-normal)]">{remoteAccessModeLabel}</p>
                            </div>
                            <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                                Local Target
                              </span>
                              <p className="mt-2 break-all text-[14px] text-[var(--vk-text-normal)]">
                                {remoteAccessSettings.localUrl ?? "Not resolved"}
                              </p>
                            </div>
                            <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                                Remote URL
                              </span>
                              <p className="mt-2 break-all text-[14px] text-[var(--vk-text-normal)]">
                                {remoteAccessSettings.publicUrl ?? "Not resolved"}
                              </p>
                            </div>
                          </div>

                          {showManagedTunnelControls ? (
                            <div className="space-y-3 rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="space-y-1">
                                  <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                                    {usingPrivateNetworkFlow ? "Private Network Link" : "Managed Remote Access"}
                                  </span>
                                  <p className="text-[13px] leading-5 text-[var(--vk-text-normal)]">
                                    {usingPrivateNetworkFlow
                                      ? "Start a private Tailscale link inside Conductor. Only authenticated devices on your tailnet can reach this URL."
                                      : "Conductor no longer starts public share tunnels. Use a private Tailscale link here, or configure a protected Cloudflare Access URL separately."}
                                  </p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void mutateRemoteAccess("enable")}
                                    disabled={!remoteAccessCanEnable}
                                    className="inline-flex h-8 items-center rounded-[4px] border border-[var(--vk-orange)] px-3 text-[12px] text-[var(--vk-orange)] hover:bg-[var(--vk-orange)]/10 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {remoteAccessMutating === "enable" ? "Enabling..." : remoteAccessEnableLabel}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void mutateRemoteAccess("disable")}
                                    disabled={!remoteAccessCanDisable}
                                    className="inline-flex h-8 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[12px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {remoteAccessMutating === "disable" ? "Disabling..." : "Disable"}
                                  </button>
                                </div>
                              </div>

                              <p className="text-[12px] leading-5 text-[var(--vk-text-muted)]">
                                {usingPrivateNetworkFlow
                                  ? remoteAccessSettings.installed
                                    ? "Tailscale is available on this machine. Conductor will publish a private HTTPS link inside your tailnet."
                                    : remoteAccessSettings.canAutoInstall && remoteAccessSettings.autoInstallMethod === "brew"
                                      ? "Tailscale is not installed yet. Conductor can install it automatically with Homebrew, but the machine still needs a Tailscale sign-in."
                                      : "Tailscale is not installed on this machine yet. Install and sign in once to enable the private remote link."
                                  : "Managed remote access now uses only a private Tailscale link. For an enterprise public URL, configure Cloudflare Access separately and point Conductor at that protected address."}
                              </p>
                            </div>
                          ) : (
                            <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
                              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                                Enterprise Policy
                              </span>
                              <p className="mt-2 text-[13px] leading-5 text-[var(--vk-text-normal)]">
                                {remoteAccessSettings.recommendedProvider === "tailscale"
                                  ? "Conductor is set up for a private VPN-style link. Install and sign in to Tailscale, then enable the private link from this screen."
                                  : "Conductor no longer publishes bearer-style unlock URLs. Configure verified Cloudflare Access and point `CONDUCTOR_PUBLIC_DASHBOARD_URL` at the protected external URL instead."}
                              </p>
                            </div>
                          )}

                          {remoteAccessSettings.lastError && (
                            <div className="rounded-[6px] border border-[var(--vk-red)]/35 bg-[var(--vk-red)]/10 px-4 py-3">
                              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-red)]">
                                {usingPrivateNetworkFlow ? "Private Link Error" : "Tunnel Error"}
                              </span>
                              <p className="mt-2 text-[12px] leading-5 text-[var(--vk-red)]">
                                {remoteAccessSettings.lastError}
                              </p>
                            </div>
                          )}

                          {remoteAccessSettings.connectUrl ? (
                            <div className="space-y-2 rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="space-y-1">
                                  <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                                    {remoteAccessSettings.mode === "private-network"
                                      ? "Private Remote URL"
                                      : "Protected Remote URL"}
                                  </span>
                                  <p className="text-[12px] text-[var(--vk-text-muted)]">
                                    {remoteAccessSettings.mode === "private-network"
                                      ? "Share this URL only with operators who are already authenticated to your private network."
                                      : "Share this protected URL. Recipients still need to pass the enterprise identity check before they reach Conductor."}
                                  </p>
                                </div>
                                <CopySnippetButton value={remoteAccessSettings.connectUrl} idleLabel="Copy URL" />
                              </div>
                              <code className="block break-all rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-3 text-[12px] leading-5 text-[var(--vk-text-normal)]">
                                {remoteAccessSettings.connectUrl}
                              </code>
                            </div>
                          ) : (
                            <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                              <p className="text-[13px] text-[var(--vk-text-normal)]">
                                {remoteAccessSettings.mode === "enterprise-only"
                                  ? remoteAccessSettings.recommendedProvider === "tailscale"
                                    ? remoteAccessSettings.connected
                                      ? "A private VPN URL will appear here after you enable the private link."
                                      : "A private VPN URL will appear here after Tailscale is installed and signed in."
                                    : "A protected enterprise remote URL will appear here after verified Cloudflare Access is configured."
                                  : "A protected remote URL is not available yet."}
                              </p>
                            </div>
                          )}

                          {remoteAccessSettings.warnings.length > 0 && (
                            <div className="space-y-2 rounded-[6px] border border-[var(--vk-red)]/35 bg-[var(--vk-red)]/10 px-4 py-3">
                              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-red)]">
                                Security Warnings
                              </span>
                              <div className="space-y-1.5">
                                {remoteAccessSettings.warnings.map((warning) => (
                                  <p key={warning} className="text-[12px] leading-5 text-[var(--vk-red)]">
                                    {warning}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}

                          {remoteAccessSettings.nextSteps.length > 0 && (
                            <div className="space-y-2 rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                              <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">Next Steps</span>
                              <div className="space-y-1.5">
                                {remoteAccessSettings.nextSteps.map((step) => (
                                  <p key={step} className="text-[12px] leading-5 text-[var(--vk-text-muted)]">
                                    {step}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </section>

                    </div>
                  )}
                </div>
              ) : isRepositoriesTab ? (
                <div className="space-y-5">
                  <section className="space-y-1">
                    <h4 className="text-[24px] leading-[24px] text-[var(--vk-text-strong)]">
                      {isOnboarding ? "Repository Defaults" : "Repository Configuration"}
                    </h4>
                    <p className="text-[14px] text-[var(--vk-text-muted)]">
                      {isOnboarding
                        ? "Review the repository Conductor will use for this workspace. You can edit advanced scripts later from Settings."
                        : "Configure scripts and defaults used whenever this repository is selected for workspaces."}
                    </p>
                  </section>

                  {(mode === "settings" || repositories.length > 1) && (
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
                  )}

                  {isOnboarding && repositories.length === 1 && repositoryDraft && (
                    <label className="block">
                      <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Detected Repository</span>
                      <div className="rounded-[4px] border border-[var(--vk-border)] bg-[rgba(15,15,15,0.52)] px-3 py-3 text-[13px] text-[var(--vk-text-normal)]">
                        {repositoryDraft.displayName}
                        <span className="ml-2 text-[var(--vk-text-muted)]">{repositoryDraft.path}</span>
                      </div>
                    </label>
                  )}

                  {repositoryDraft && (
                    <>
                      {mode === "settings" && (
                        <section className="space-y-3 border-t border-[var(--vk-border)] pt-4">
                        <div className="space-y-1">
                          <h5 className="text-[22px] leading-[22px] text-[var(--vk-text-strong)]">Repo-Preseed Bootstrap</h5>
                          <p className="text-[13px] text-[var(--vk-text-muted)]">
                            Use this when you already know the target repository and want one command to prefill it. The
                            default first-run path is still `npx conductor-oss@latest`, which opens the dashboard and lets
                            the user choose preferences before adding a project.
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2 text-[11px] text-[var(--vk-text-muted)]">
                          <span className="rounded-[999px] border border-[var(--vk-border)] px-2 py-1">
                            Workspace: {repositoryDraft.workspaceMode}
                          </span>
                          <span className="rounded-[999px] border border-[var(--vk-border)] px-2 py-1">
                            Runtime: {repositoryDraft.runtimeMode}
                          </span>
                          <span className="rounded-[999px] border border-[var(--vk-border)] px-2 py-1">
                            SCM: {repositoryDraft.scmMode}
                          </span>
                        </div>

                        <div className="rounded-[4px] border border-[var(--vk-border)] bg-[rgba(15,15,15,0.72)] p-3">
                          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[12px] leading-5 text-[var(--vk-text-normal)]">
                            {repositoryBootstrapCommand}
                          </pre>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-[12px] text-[var(--vk-text-muted)]">
                            This command uses your selected agent, editor, and notes app. Best on macOS with Homebrew.
                            GitHub sign-in still opens a browser so the user can approve access.
                          </p>
                          <CopySnippetButton value={repositoryBootstrapCommand} idleLabel="Copy Setup Command" />
                        </div>
                        </section>
                      )}

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
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Repository Slug</span>
                          <input
                            value={repositoryDraft.repo}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, repo: event.target.value } : prev)}
                            placeholder="e.g., your-org/your-repo"
                            className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[14px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          />
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">Used for PR tracking, GitHub links, and onboarding defaults.</p>
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Default Agent</span>
                          <select
                            value={repositoryDraft.agent}
                            onChange={(event) => {
                              const nextAgent = event.target.value;
                              setRepositoryDraft((prev) => prev ? { ...prev, agent: nextAgent } : prev);
                              setRepositoryModelSelection(buildModelSelection(nextAgent, modelAccess, runtimeModelCatalogs, null));
                            }}
                            className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          >
                            {orderedAgentOptions.map((agent) => (
                              <option key={agent} value={agent}>
                                {getAgentLabel(agent)}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">Used by the one-line bootstrap and as the project default when tasks dispatch.</p>
                        </label>

                        {supportsAgentModelSelection(repositoryDraft.agent) && (
                          <div className="rounded-[4px] border border-[var(--vk-border)] px-3 py-3">
                            <AgentModelSelector
                              agent={repositoryDraft.agent}
                              modelAccess={modelAccess}
                              runtimeModelCatalogs={runtimeModelCatalogs}
                              selection={repositoryModelSelection}
                              onChange={setRepositoryModelSelection}
                            />
                          </div>
                        )}

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Agent Permission Default</span>
                          <select
                            value={repositoryDraft.agentPermissions}
                            onChange={(event) => setRepositoryDraft((prev) => prev ? {
                              ...prev,
                              agentPermissions: event.target.value === "default" ? "default" : "skip",
                            } : prev)}
                            className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                          >
                            <option value="skip">Auto approve and allow local dev servers</option>
                            <option value="default">Sandboxed default mode</option>
                          </select>
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                            Applies to new sessions for this repository across all agents unless you override the launch mode.
                          </p>
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

                      {mode === "settings" && (
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
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                            Optional. Leave this blank if you run the local app yourself and only want Conductor to auto-connect the preview.
                          </p>
                        </label>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Dev Server CWD</span>
                            <input
                              value={repositoryDraft.devServerCwd}
                              onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, devServerCwd: event.target.value } : prev)}
                              placeholder="e.g., apps/web"
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            />
                            <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">Runs the dev server from this subdirectory when set.</p>
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Preview URL Override</span>
                            <input
                              value={repositoryDraft.devServerUrl}
                              onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, devServerUrl: event.target.value } : prev)}
                              placeholder="e.g., https://preview.example.com"
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            />
                            <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">If set, preview connects here first instead of inferring from logs.</p>
                          </label>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-4">
                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Preview Port</span>
                            <input
                              value={repositoryDraft.devServerPort}
                              onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, devServerPort: event.target.value } : prev)}
                              inputMode="numeric"
                              placeholder="3000"
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            />
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Preview Host</span>
                            <input
                              value={repositoryDraft.devServerHost}
                              onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, devServerHost: event.target.value } : prev)}
                              placeholder="127.0.0.1"
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            />
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Preview Path</span>
                            <input
                              value={repositoryDraft.devServerPath}
                              onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, devServerPath: event.target.value } : prev)}
                              placeholder="/"
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)]"
                            />
                          </label>

                          <label className="flex items-center gap-2 rounded-[4px] border border-[var(--vk-border)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                            <input
                              type="checkbox"
                              checked={repositoryDraft.devServerHttps}
                              onChange={(event) => setRepositoryDraft((prev) => prev ? { ...prev, devServerHttps: event.target.checked } : prev)}
                              className="h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
                            />
                            <span>Use HTTPS</span>
                          </label>
                        </div>

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
                      )}
                    </>
                  )}
                </div>
              ) : isOrganizationTab ? (
                <div className="space-y-5">
                  <section className="rounded-[6px] border border-[var(--vk-border)] bg-[rgba(234,122,42,0.06)] px-4 py-3">
                    <h4 className="text-[15px] font-medium text-[var(--vk-text-strong)]">Security-First Remote Access</h4>
                    <p className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                      The dashboard stays bound to localhost. For phone and team access, put a verified edge
                      identity layer like Cloudflare Access in front of it, then map authenticated users into
                      viewer, operator, or admin roles here.
                    </p>
                  </section>

                  {accessLoading ? (
                    <section className="flex items-center gap-2 rounded-[6px] border border-[var(--vk-border)] px-4 py-4 text-[13px] text-[var(--vk-text-muted)]">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading organization access settings...
                    </section>
                  ) : (
                    <>
                      <section className="grid gap-3 lg:grid-cols-3">
                        <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                          <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                            Current Identity
                          </span>
                          <p className="mt-2 text-[14px] text-[var(--vk-text-normal)]">
                            {accessSettings.current.email ?? "Anonymous local session"}
                          </p>
                        </div>
                        <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                          <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                            Effective Role
                          </span>
                          <p className="mt-2 text-[14px] text-[var(--vk-text-normal)]">
                            {accessSettings.current.role ?? "No access"}
                          </p>
                        </div>
                        <div className="rounded-[6px] border border-[var(--vk-border)] px-4 py-3">
                          <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--vk-text-muted)]">
                            Auth Provider
                          </span>
                          <p className="mt-2 text-[14px] text-[var(--vk-text-normal)]">
                            {accessSettings.current.provider ?? "Local only"}
                          </p>
                        </div>
                      </section>

                      {!accessCanEdit && (
                        <section className="rounded-[6px] border border-[var(--vk-border)] bg-[rgba(80,80,80,0.18)] px-4 py-3">
                          <p className="text-[12px] leading-5 text-[var(--vk-text-muted)]">
                            You can review organization security here, but only an admin session can save changes.
                            Use a local admin session or an admin identity from your edge auth provider to modify access rules.
                          </p>
                        </section>
                      )}

                      <section className="space-y-3 rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
                        <div className="space-y-1">
                          <h5 className="text-[18px] leading-[20px] text-[var(--vk-text-strong)]">Baseline Access Rules</h5>
                          <p className="text-[12px] text-[var(--vk-text-muted)]">
                            Require authentication for remote dashboard requests and decide what authenticated users get
                            by default before explicit role bindings are applied. Localhost on this machine stays in a
                            local admin recovery mode so setup and break-glass access keep working.
                          </p>
                        </div>

                        <label className="flex items-start gap-2 rounded-[4px] border border-[var(--vk-border)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                          <input
                            type="checkbox"
                            checked={accessSettings.requireAuth}
                            onChange={(event) => setAccessSettings((prev) => ({
                              ...prev,
                              requireAuth: event.target.checked,
                            }))}
                            disabled={!accessCanEdit || accessSaving || accessSettings.trustedHeaders.enabled}
                            className="mt-0.5 h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
                          />
                          <span>Require authentication for remote dashboard requests</span>
                        </label>

                        <p className="rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-2 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                          Public share-link remote control has been removed. Remote access now requires either the private
                          Tailscale link or an identity-bound provider such as Cloudflare Access or Clerk.
                        </p>

                        <label className="block">
                          <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Default Role</span>
                          <select
                            value={accessSettings.defaultRole}
                            onChange={(event) => setAccessSettings((prev) => ({
                              ...prev,
                              defaultRole: event.target.value as DashboardRole,
                            }))}
                            disabled={!accessCanEdit || accessSaving}
                            className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)] disabled:opacity-60"
                          >
                            <option value="viewer">Viewer</option>
                            <option value="operator">Operator</option>
                            <option value="admin">Admin</option>
                          </select>
                          <p className="mt-1 text-[12px] text-[var(--vk-text-muted)]">
                            This applies after identity verification when no explicit email or domain binding matches.
                            Cloudflare Access enterprise mode forces full authentication automatically.
                          </p>
                        </label>
                      </section>

                      <section className="space-y-3 rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
                        <div className="space-y-1">
                          <h5 className="text-[18px] leading-[20px] text-[var(--vk-text-strong)]">Verified Edge Auth</h5>
                          <p className="text-[12px] text-[var(--vk-text-muted)]">
                            Recommended for secure public phone access and free team collaboration. Conductor verifies
                            the Cloudflare Access JWT instead of trusting a raw email header.
                          </p>
                        </div>

                        <label className="flex items-start gap-2 rounded-[4px] border border-[var(--vk-border)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)]">
                          <input
                            type="checkbox"
                            checked={accessSettings.trustedHeaders.enabled}
                            onChange={(event) => setAccessSettings((prev) => ({
                              ...prev,
                              requireAuth: event.target.checked ? true : prev.requireAuth,
                              trustedHeaders: {
                                ...prev.trustedHeaders,
                                enabled: event.target.checked,
                              },
                            }))}
                            disabled={!accessCanEdit || accessSaving}
                            className="mt-0.5 h-4 w-4 rounded border border-[var(--vk-border)] bg-transparent accent-[var(--vk-orange)]"
                          />
                          <span>Enable verified Cloudflare Access authentication</span>
                        </label>

                        <div className="grid gap-3 lg:grid-cols-2">
                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Provider</span>
                            <div className="flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 text-[13px] text-[var(--vk-text-normal)]">
                              Cloudflare Access (verified JWT)
                            </div>
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Identity Email Header</span>
                            <input
                              value={accessSettings.trustedHeaders.emailHeader}
                              onChange={(event) => setAccessSettings((prev) => ({
                                ...prev,
                                trustedHeaders: {
                                  ...prev.trustedHeaders,
                                  emailHeader: event.target.value,
                                },
                              }))}
                              disabled={!accessCanEdit || accessSaving}
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)] disabled:opacity-60"
                            />
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">JWT Assertion Header</span>
                            <input
                              value={accessSettings.trustedHeaders.jwtHeader}
                              onChange={(event) => setAccessSettings((prev) => ({
                                ...prev,
                                trustedHeaders: {
                                  ...prev.trustedHeaders,
                                  jwtHeader: event.target.value,
                                },
                              }))}
                              disabled={!accessCanEdit || accessSaving}
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)] disabled:opacity-60"
                            />
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Cloudflare Team Domain</span>
                            <input
                              value={accessSettings.trustedHeaders.teamDomain}
                              onChange={(event) => setAccessSettings((prev) => ({
                                ...prev,
                                trustedHeaders: {
                                  ...prev.trustedHeaders,
                                  teamDomain: event.target.value,
                                },
                              }))}
                              disabled={!accessCanEdit || accessSaving}
                              placeholder="your-team.cloudflareaccess.com"
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)] disabled:opacity-60"
                            />
                          </label>

                          <label className="block lg:col-span-2">
                            <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">Cloudflare Access Audience</span>
                            <input
                              value={accessSettings.trustedHeaders.audience}
                              onChange={(event) => setAccessSettings((prev) => ({
                                ...prev,
                                trustedHeaders: {
                                  ...prev.trustedHeaders,
                                  audience: event.target.value,
                                },
                              }))}
                              disabled={!accessCanEdit || accessSaving}
                              placeholder="Copy the AUD value from your Cloudflare Access application"
                              className="h-9 w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)] disabled:opacity-60"
                            />
                          </label>
                        </div>

                        <p className="rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-2 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                          Enterprise remote access requires a Cloudflare Access application that injects a verified JWT
                          and email header. Conductor will not publish a shareable admin URL when that verification layer
                          is missing.
                        </p>
                      </section>

                      <section className="space-y-3 rounded-[6px] border border-[var(--vk-border)] px-4 py-4">
                        <div className="space-y-1">
                          <h5 className="text-[18px] leading-[20px] text-[var(--vk-text-strong)]">Role Bindings</h5>
                          <p className="text-[12px] text-[var(--vk-text-muted)]">
                            Map verified team identities into least-privilege roles. `viewer` can inspect work, `operator`
                            can control agents, and `admin` can change global settings.
                          </p>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-2">
                          {accessRoleFields.map(({ label, key, placeholder }) => (
                            <label key={key} className="block">
                              <span className="mb-1.5 block text-[12px] font-medium text-[var(--vk-text-normal)]">{label}</span>
                              <textarea
                                rows={4}
                                value={accessSettings.roles[key]}
                                onChange={(event) => setAccessSettings((prev) => ({
                                  ...prev,
                                  roles: {
                                    ...prev.roles,
                                    [key]: event.target.value,
                                  },
                                }))}
                                disabled={!accessCanEdit || accessSaving}
                                placeholder={placeholder}
                                className="w-full rounded-[4px] border border-[var(--vk-border)] bg-transparent px-2 py-2 text-[13px] text-[var(--vk-text-normal)] outline-none focus:border-[var(--vk-orange)] disabled:opacity-60"
                              />
                              <p className="mt-1 text-[11px] text-[var(--vk-text-muted)]">One entry per line.</p>
                            </label>
                          ))}
                        </div>
                      </section>
                    </>
                  )}
                </div>
              ) : (
                <section className="space-y-3">
                  <h4 className="text-[16px] font-medium text-[var(--vk-text-strong)]">{activeTabItem.label}</h4>
                  <p className="text-[14px] text-[var(--vk-text-muted)]">
                    This section is queued for implementation. General, Agents, Remote Access, and repository settings are available now.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab("general")}
                    className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                  >
                    Open General
                  </button>
                </section>
              )}
            </div>

            <footer className="flex flex-col gap-3 border-t border-[var(--vk-border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
              <div className="min-w-0">
                {dialogError && (
                  <p className="truncate rounded-[4px] border border-[var(--vk-red)]/35 bg-[var(--vk-red)]/10 px-2 py-1 text-[12px] text-[var(--vk-red)]">
                    {dialogError}
                  </p>
                )}
                {!dialogError && isPreferenceFormTab && (
                  <p className="text-[11px] text-[var(--vk-text-muted)]">
                    {isOnboarding
                      ? "Finish setup once here. You can change these preferences any time from Settings."
                      : "Preferences are saved to your conductor config and applied immediately."}
                  </p>
                )}
                {!dialogError && isRepositoriesTab && (
                  <p className="text-[11px] text-[var(--vk-text-muted)]">
                    {isOnboarding
                      ? "These defaults will be used the first time workspaces and tasks are created for this repo."
                      : "Repository settings are saved to your conductor config and used for future workspaces."}
                  </p>
                )}
                {!dialogError && isOrganizationTab && (
                  <p className="text-[11px] text-[var(--vk-text-muted)]">
                    Organization access settings are written into `conductor.yaml`. Use admin role bindings for full
                    control, operator bindings for day-to-day agent usage, and viewer bindings for read-only access.
                  </p>
                )}
              </div>
              <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                {!isOnboarding && (
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={isBusy}
                    className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    Close
                  </button>
                )}
                {isOnboarding && isRepositoriesTab && (
                  <button
                    type="button"
                    onClick={() => setActiveTab("preferences")}
                    disabled={isBusy}
                    className="inline-flex h-9 items-center rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    Back
                  </button>
                )}
                {isPreferenceFormTab && !isOnboarding && (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSubmitPreferences(current.onboardingAcknowledged, { closeDialog: true });
                    }}
                    disabled={!canSubmitPreferences || creating}
                    className="inline-flex h-9 items-center rounded-[4px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    {creating ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Saving...
                      </>
                    ) : "Save"}
                  </button>
                )}
                {isRepositoriesTab && !isOnboarding && (
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
                {isOrganizationTab && !isOnboarding && (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSaveAccess();
                    }}
                    disabled={!canSaveAccess || accessSaving}
                    className="inline-flex h-9 items-center rounded-[4px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    {accessSaving ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Saving...
                      </>
                    ) : "Save Access"}
                  </button>
                )}
                {isOnboarding && (
                  <button
                    type="button"
                    onClick={() => {
                      void (isPreferencesTab ? handleOnboardingContinue() : handleFinishOnboarding());
                    }}
                    disabled={
                      isPreferencesTab
                        ? !canSubmitPreferences || creating || repositoriesLoading
                        : !canSaveRepository || isBusy
                    }
                    className="inline-flex h-9 items-center rounded-[4px] bg-[var(--vk-bg-active)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-50"
                  >
                    {isBusy || (isPreferencesTab && repositoriesLoading) ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        {isPreferencesTab && repositoriesLoading ? "Loading..." : "Saving..."}
                      </>
                    ) : isPreferencesTab ? (
                      onboardingHasRepositoryStep ? "Continue" : "Finish Setup"
                    ) : (
                      "Finish Setup"
                    )}
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
      <FolderPickerDialog
        open={notesFolderPickerOpen}
        initialPath={markdownEditorPath ?? ""}
        title="Select Notes Root"
        description="Choose the local Obsidian vault, Logseq graph, or markdown notes folder used for context attachments."
        onClose={() => setNotesFolderPickerOpen(false)}
        onSelect={(selectedPath) => {
          setNotesFolderPickerOpen(false);
          if (selectedPath === null) return;
          setMarkdownEditorPath(selectedPath);
        }}
      />
    </>
  );
}
