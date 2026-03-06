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
  remoteSshHost?: string | null;
  remoteSshUser?: string | null;
  markdownEditor?: string;
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
  agentModel?: string | null;
  agentReasoningEffort?: string | null;
  agentPermissions?: "skip" | "default";
};

export type ConductorYamlScaffoldConfig = {
  port?: number;
  dashboardUrl?: string | null;
  access?: {
    requireAuth?: boolean;
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

  if (project.defaultWorkingDirectory?.trim()) {
    nextProject["defaultWorkingDirectory"] = project.defaultWorkingDirectory.trim();
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

  if (preferences.remoteSshHost?.trim()) {
    (root["preferences"] as Record<string, unknown>)["remoteSshHost"] = preferences.remoteSshHost.trim();
  }
  if (preferences.remoteSshUser?.trim()) {
    (root["preferences"] as Record<string, unknown>)["remoteSshUser"] = preferences.remoteSshUser.trim();
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

  return stringify(root, { lineWidth: 0 });
}
