import { basename } from "node:path";
import { stringify } from "yaml";
import { generateSessionPrefix } from "./paths.js";
import { getDefaultModelAccessPreferences, type ModelAccessPreferences } from "./types.js";

export type ScaffoldNotificationPreferences = {
  soundEnabled?: boolean;
  soundFile?: string | null;
};

export type ScaffoldPreferencesConfig = {
  onboardingAcknowledged?: boolean;
  codingAgent?: string;
  ide?: string;
  markdownEditor?: string;
  markdownEditorPath?: string;
  modelAccess?: ModelAccessPreferences;
  notifications?: ScaffoldNotificationPreferences;
};

export type ScaffoldProjectConfig = {
  projectId: string;
  displayName?: string;
  repo: string;
  path: string;
  agent: string;
  defaultBranch: string;
  defaultWorkingDirectory?: string | null;
  sessionPrefix?: string | null;
  workspace?: string | null;
  runtime?: string | null;
  scm?: string | null;
  boardDir?: string | null;
  githubProject?: {
    id?: string | null;
    ownerLogin?: string | null;
    number?: number | null;
    title?: string | null;
    url?: string | null;
    statusFieldId?: string | null;
    statusFieldName?: string | null;
  } | null;
  devServer?: {
    command?: string | null;
    cwd?: string | null;
    url?: string | null;
    port?: number | null;
    host?: string | null;
    path?: string | null;
    https?: boolean | null;
  } | null;
  agentModel?: string | null;
  agentReasoningEffort?: string | null;
  agentPermissions?: "skip" | "default";
};

export type ConductorYamlScaffoldConfig = {
  port?: number;
  dashboardUrl?: string | null;
  access?: {
    requireAuth?: boolean;
    allowSignedShareLinks?: boolean;
    defaultRole?: "viewer" | "operator" | "admin";
    trustedHeaders?: {
      enabled?: boolean;
      provider?: "generic" | "cloudflare-access";
      emailHeader?: string;
      jwtHeader?: string;
      teamDomain?: string;
      audience?: string;
    };
  };
  preferences?: ScaffoldPreferencesConfig;
  projects?: ScaffoldProjectConfig[];
};

function normalizeProjectDisplayName(project: ScaffoldProjectConfig): string {
  const explicit = project.displayName?.trim();
  if (explicit) return explicit;
  const fallback = basename(project.path).trim();
  return fallback.length > 0 ? fallback : project.projectId;
}

export function buildConductorBoard(projectId: string, displayName: string): string {
  return `# ${displayName}

> Conductor AI agent orchestrator. Tags: \`#project/${projectId}\` \`#agent/claude-code\` \`#agent/codex\` \`#agent/gemini\`

## Inbox

> Drop rough ideas here.

## Ready to Dispatch

> Move tagged tasks here to dispatch an agent.

## Dispatching

## In Progress

## Review

## Done

## Blocked
`;
}

export function buildProjectConfigRecord(project: ScaffoldProjectConfig): Record<string, unknown> {
  const nextProject: Record<string, unknown> = {
    name: normalizeProjectDisplayName(project),
    path: project.path,
    repo: project.repo,
    agent: project.agent,
    defaultBranch: project.defaultBranch,
    sessionPrefix: project.sessionPrefix?.trim() || generateSessionPrefix(basename(project.path)),
    workspace: project.workspace?.trim() || "worktree",
    runtime: project.runtime?.trim() || "tmux",
    agentConfig: {
      permissions: project.agentPermissions ?? "skip",
    },
  };

  if (project.scm?.trim()) {
    nextProject["scm"] = project.scm.trim();
  } else if (project.repo.includes("/")) {
    nextProject["scm"] = "github";
  }

  if (project.boardDir?.trim()) {
    nextProject["boardDir"] = project.boardDir.trim();
  }

  if (project.githubProject?.id?.trim()) {
    nextProject["githubProject"] = {
      id: project.githubProject.id.trim(),
      ...(project.githubProject.ownerLogin?.trim() ? { ownerLogin: project.githubProject.ownerLogin.trim() } : {}),
      ...(typeof project.githubProject.number === "number" ? { number: project.githubProject.number } : {}),
      ...(project.githubProject.title?.trim() ? { title: project.githubProject.title.trim() } : {}),
      ...(project.githubProject.url?.trim() ? { url: project.githubProject.url.trim() } : {}),
      ...(project.githubProject.statusFieldId?.trim() ? { statusFieldId: project.githubProject.statusFieldId.trim() } : {}),
      ...(project.githubProject.statusFieldName?.trim() ? { statusFieldName: project.githubProject.statusFieldName.trim() } : {}),
    };
  }

  if (project.defaultWorkingDirectory?.trim()) {
    nextProject["defaultWorkingDirectory"] = project.defaultWorkingDirectory.trim();
  }

  const devServer: Record<string, unknown> = {};
  if (project.devServer?.command?.trim()) {
    devServer["command"] = project.devServer.command.trim();
  }
  if (project.devServer?.cwd?.trim()) {
    devServer["cwd"] = project.devServer.cwd.trim();
  }
  if (project.devServer?.url?.trim()) {
    devServer["url"] = project.devServer.url.trim();
  }
  if (typeof project.devServer?.port === "number") {
    devServer["port"] = project.devServer.port;
  }
  if (project.devServer?.host?.trim()) {
    devServer["host"] = project.devServer.host.trim();
  }
  if (project.devServer?.path?.trim()) {
    devServer["path"] = project.devServer.path.trim();
  }
  if (typeof project.devServer?.https === "boolean") {
    devServer["https"] = project.devServer.https;
  }
  if (Object.keys(devServer).length > 0) {
    nextProject["devServer"] = devServer;
  }

  if (project.agentModel?.trim()) {
    nextProject["agentConfig"] = {
      ...(nextProject["agentConfig"] as Record<string, unknown>),
      model: project.agentModel.trim(),
    };
  }

  if (project.agentReasoningEffort?.trim()) {
    nextProject["agentConfig"] = {
      ...(nextProject["agentConfig"] as Record<string, unknown>),
      reasoningEffort: project.agentReasoningEffort.trim(),
    };
  }

  return nextProject;
}

/**
 * Marker added to generated project-local conductor.yaml files.
 * Presence indicates the file is a mirror of the workspace canonical config.
 */
export const GENERATED_MARKER_KEY = "_generatedFromWorkspace";

export function buildConductorYaml(config: ConductorYamlScaffoldConfig = {}): string {
  const preferences = config.preferences ?? {};
  const port = config.port ?? 4747;
  const dashboardUrl = config.dashboardUrl?.trim() || `http://localhost:${port}`;
  const modelAccess = {
    ...getDefaultModelAccessPreferences(),
    ...(preferences.modelAccess ?? {}),
  };
  const root: Record<string, unknown> = {
    port,
    dashboardUrl,
    access: {
      requireAuth: config.access?.requireAuth === true,
      allowSignedShareLinks: config.access?.allowSignedShareLinks === true,
      defaultRole: config.access?.defaultRole ?? "operator",
      trustedHeaders: {
        enabled: config.access?.trustedHeaders?.enabled === true,
        provider: config.access?.trustedHeaders?.provider?.trim() || "cloudflare-access",
        emailHeader: config.access?.trustedHeaders?.emailHeader?.trim() || "Cf-Access-Authenticated-User-Email",
        jwtHeader: config.access?.trustedHeaders?.jwtHeader?.trim() || "Cf-Access-Jwt-Assertion",
      },
    },
    preferences: {
      onboardingAcknowledged: preferences.onboardingAcknowledged === true,
      codingAgent: preferences.codingAgent?.trim() || "claude-code",
      ide: preferences.ide?.trim() || "vscode",
      markdownEditor: preferences.markdownEditor?.trim() || "obsidian",
      modelAccess,
      notifications: {
        soundEnabled: preferences.notifications?.soundEnabled !== false,
        soundFile: preferences.notifications?.soundFile === null
          ? null
          : preferences.notifications?.soundFile?.trim() || "abstract-sound-4",
      },
    },
    projects: {},
  };

  if (preferences.markdownEditorPath?.trim()) {
    (root["preferences"] as Record<string, unknown>)["markdownEditorPath"] = preferences.markdownEditorPath.trim();
  }

  const projects = config.projects ?? [];
  const projectMap = root["projects"] as Record<string, unknown>;
  const trustedHeaders = ((root["access"] as Record<string, unknown>)["trustedHeaders"] ?? {}) as Record<string, unknown>;
  if (config.access?.trustedHeaders?.teamDomain?.trim()) {
    trustedHeaders["teamDomain"] = config.access.trustedHeaders.teamDomain.trim();
  }
  if (config.access?.trustedHeaders?.audience?.trim()) {
    trustedHeaders["audience"] = config.access.trustedHeaders.audience.trim();
  }
  for (const project of projects) {
    projectMap[project.projectId] = buildProjectConfigRecord(project);
  }

  // Add generation marker so drift detection can identify managed files
  root[GENERATED_MARKER_KEY] = new Date().toISOString();

  return stringify(root, { lineWidth: 0 });
}
