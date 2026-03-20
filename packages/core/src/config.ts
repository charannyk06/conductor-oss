/**
 * Configuration loader -- reads conductor.yaml and validates with Zod.
 *
 * Minimal config that just works:
 *   projects:
 *     my-app:
 *       repo: org/repo
 *       path: ~/my-app
 *
 * Everything else has sensible defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { getDefaultModelAccessPreferences, type OrchestratorConfig } from "./types.js";
import { generateSessionPrefix } from "./paths.js";
import { resolveConfiguredProjectPath } from "./project-paths.js";

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const MCPServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
});

const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z.enum(["send-to-agent", "notify", "auto-merge"]).default("notify"),
  message: z.string().optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  includeSummary: z.boolean().optional(),
});

// Accept either shorthand string ("github") or object ({ plugin: "github" })
const PluginRefSchema = z.union([
  z.string().transform((s) => ({ plugin: s })),
  z.object({ plugin: z.string() }).passthrough(),
]);

const TrackerConfigSchema = PluginRefSchema;
const SCMConfigSchema = PluginRefSchema;

const NotifierConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const AgentSpecificConfigSchema = z
  .object({
    permissions: z.enum(["skip", "default"]).default("skip"),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
  })
  .passthrough();

const AgentProfileSchema = z
  .object({
    agent: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    permissions: z.enum(["skip", "default"]).optional(),
  })
  .passthrough();

const DEFAULT_AGENT_CONFIG = {
  permissions: "skip" as const,
};

const DEFAULT_PROJECT_PLUGINS = {
  runtime: "ttyd" as const,
  agent: "claude-code" as const,
  workspace: "worktree" as const,
  notifiers: ["desktop"],
};

const DevServerConfigSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  path: z.string().optional(),
  https: z.boolean().optional(),
});

const ColumnAliasesSchema = z.object({
  intake: z.array(z.string()).optional(),
  ready: z.array(z.string()).optional(),
  dispatching: z.array(z.string()).optional(),
  inProgress: z.array(z.string()).optional(),
  review: z.array(z.string()).optional(),
  done: z.array(z.string()).optional(),
  blocked: z.array(z.string()).optional(),
});

const BoardConfigEntrySchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    aliases: ColumnAliasesSchema.optional(),
  }),
]);

const GitHubProjectConfigSchema = z.object({
  id: z.string().optional(),
  ownerLogin: z.string().optional(),
  number: z.number().int().positive().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  statusFieldId: z.string().optional(),
  statusFieldName: z.string().optional(),
});

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: z.string(),
  path: z.string(),
  defaultBranch: z.string().default("main"),
  defaultWorkingDirectory: z.string().optional(),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  /** Maps this project to an Obsidian board directory name (when dir name != config key). */
  boardDir: z.string().optional(),
  githubProject: GitHubProjectConfigSchema.optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  setupScript: z.array(z.string()).optional(),
  runSetupInParallel: z.boolean().optional(),
  cleanupScript: z.array(z.string()).optional(),
  archiveScript: z.array(z.string()).optional(),
  copyFiles: z.array(z.string()).optional(),
  agentConfig: AgentSpecificConfigSchema.default(DEFAULT_AGENT_CONFIG),
  reactions: z.record(z.string(), ReactionConfigSchema.partial()).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  mcpServers: z.record(z.string(), MCPServerConfigSchema).optional(),
  agentProfiles: z.record(z.string(), AgentProfileSchema).optional(),
  defaultProfile: z.string().optional(),
  devServer: DevServerConfigSchema.optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("ttyd"),
  agent: z.string().default("claude-code"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default(["desktop"]),
  mcpServers: z.record(z.string(), MCPServerConfigSchema).optional(),
});

const WebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().default(4748),
  secret: z.string().optional(),
});

const NotificationPreferencesSchema = z.object({
  soundEnabled: z.boolean().default(true),
  soundFile: z.string().nullable().default("abstract-sound-4"),
});

const ModelAccessPreferencesSchema = z.object({
  claudeCode: z.enum(["pro", "max", "api"]).optional(),
  codex: z.enum(["chatgpt", "api"]).optional(),
  gemini: z.enum(["oauth", "api"]).optional(),
  qwenCode: z.enum(["oauth", "api"]).optional(),
});

const UserPreferencesSchema = z.object({
  onboardingAcknowledged: z.boolean().default(false),
  codingAgent: z.string().optional(),
  ide: z.string().optional(),
  markdownEditor: z.string().optional(),
  markdownEditorPath: z.string().optional(),
  modelAccess: ModelAccessPreferencesSchema.default(getDefaultModelAccessPreferences()),
  notifications: NotificationPreferencesSchema.default({
    soundEnabled: true,
    soundFile: "abstract-sound-4",
  }),
});

const DashboardRoleSchema = z.enum(["viewer", "operator", "admin"]);
const TrustedHeaderAccessProviderSchema = z.enum(["generic", "cloudflare-access"]);

const DashboardRoleBindingsSchema = z.object({
  viewers: z.array(z.string()).optional(),
  operators: z.array(z.string()).optional(),
  admins: z.array(z.string()).optional(),
  viewerDomains: z.array(z.string()).optional(),
  operatorDomains: z.array(z.string()).optional(),
  adminDomains: z.array(z.string()).optional(),
});

const TrustedHeaderAccessConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: TrustedHeaderAccessProviderSchema.default("cloudflare-access"),
  emailHeader: z.string().default("Cf-Access-Authenticated-User-Email"),
  jwtHeader: z.string().default("Cf-Access-Jwt-Assertion"),
  teamDomain: z.string().optional(),
  audience: z.string().optional(),
});

const DashboardAccessConfigSchema = z.object({
  requireAuth: z.boolean().default(false),
  allowSignedShareLinks: z.boolean().default(false),
  defaultRole: DashboardRoleSchema.optional(),
  trustedHeaders: TrustedHeaderAccessConfigSchema.optional(),
  roles: DashboardRoleBindingsSchema.optional(),
});

const ConductorConfigSchema = z.object({
  port: z.number().default(4747),
  terminalPort: z.number().optional(),
  dashboardUrl: z.string().optional(),
  boards: z.array(BoardConfigEntrySchema).optional(),
  columnAliases: ColumnAliasesSchema.optional(),
  readyThresholdMs: z.number().nonnegative().default(300_000),
  maxSessionsPerProject: z.number().positive().default(5),
  defaults: DefaultPluginsSchema.default(DEFAULT_PROJECT_PLUGINS),
  projects: z.record(z.string(), ProjectConfigSchema),
  notifiers: z.record(z.string(), NotifierConfigSchema).default({}),
  notificationRouting: z.record(z.string(), z.array(z.string())).default({
    urgent: ["desktop"],
    action: ["desktop"],
    warning: ["desktop"],
    info: ["desktop"],
  }),
  reactions: z.record(z.string(), ReactionConfigSchema).default({}),
  webhook: WebhookConfigSchema.optional(),
  access: DashboardAccessConfigSchema.optional(),
  preferences: UserPreferencesSchema.default({
    onboardingAcknowledged: false,
    modelAccess: getDefaultModelAccessPreferences(),
    notifications: {
      soundEnabled: true,
      soundFile: "abstract-sound-4",
    },
  }),
});

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const MAX_PROJECT_ID_INPUT_LENGTH = 512;

function slugifyProjectId(value: string): string {
  // Guard against excessively long input to prevent ReDoS on uncontrolled data
  const bounded = value.length > MAX_PROJECT_ID_INPUT_LENGTH
    ? value.slice(0, MAX_PROJECT_ID_INPUT_LENGTH)
    : value;
  let normalized = bounded.trim().toLowerCase();
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }
  // Build slug character-by-character to avoid polynomial regex on
  // uncontrolled input (CodeQL js/polynomial-redos).
  let slug = "";
  let lastWasDash = true;
  for (const ch of normalized) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      slug += ch;
      lastWasDash = false;
    } else if (!lastWasDash) {
      slug += "-";
      lastWasDash = true;
    }
  }
  // Trim trailing dash
  if (slug.endsWith("-")) {
    slug = slug.slice(0, -1);
  }
  return slug || "project";
}

function ensureUniqueProjectKey(baseKey: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(baseKey)) {
    usedKeys.add(baseKey);
    return baseKey;
  }

  let suffix = 2;
  while (usedKeys.has(`${baseKey}-${suffix}`)) {
    suffix += 1;
  }

  const nextKey = `${baseKey}-${suffix}`;
  usedKeys.add(nextKey);
  return nextKey;
}

function deriveLegacyProjectKey(project: Record<string, unknown>, index: number): string {
  const explicitId = asNonEmptyString(project["projectId"]) ?? asNonEmptyString(project["id"]);
  if (explicitId) return slugifyProjectId(explicitId);

  const path = asNonEmptyString(project["path"]);
  if (path) {
    // Limit path length to prevent polynomial-time regex on pathologically long inputs.
    const capped = path.length > 10_000 ? path.slice(0, 10_000) : path;
    const pathBase = basename(capped.replace(/[\\/]+$/, ""));
    if (pathBase.trim().length > 0) return slugifyProjectId(pathBase);
  }

  const repo = asNonEmptyString(project["repo"]);
  if (repo) {
    const repoBase = repo
      .replace(/\.git$/i, "")
      .split(/[/:]/)
      .filter(Boolean)
      .pop();
    if (repoBase) return slugifyProjectId(repoBase);
  }

  const name = asNonEmptyString(project["name"]);
  if (name) return slugifyProjectId(name);

  return `project-${index + 1}`;
}

export function normalizeProjectConfigMap(value: unknown): Record<string, unknown> {
  if (!value) return {};

  if (Array.isArray(value)) {
    const normalized: Record<string, unknown> = {};
    const usedKeys = new Set<string>();

    value.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const project = { ...(entry as Record<string, unknown>) };
      const projectKey = ensureUniqueProjectKey(deriveLegacyProjectKey(project, index), usedKeys);
      delete project["id"];
      delete project["projectId"];
      normalized[projectKey] = project;
    });

    return normalized;
  }

  if (typeof value !== "object") {
    return {};
  }

  return { ...(value as Record<string, unknown>) };
}

function sanitizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeRuntime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === "direct" || trimmed === "tmux" || trimmed === "ttyd") {
    return "ttyd";
  }
  return trimmed;
}

function sanitizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
  }
  return undefined;
}

function sanitizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizePluginRef(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value;
}

function sanitizeDevServerConfig(
  value: unknown,
  project?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

  const legacyValues = {
    command: sanitizeOptionalString(project?.["devServerScript"]),
    cwd: sanitizeOptionalString(project?.["devServerCwd"]),
    url: sanitizeOptionalString(project?.["devServerUrl"]),
    port: sanitizeOptionalNumber(project?.["devServerPort"]),
    host: sanitizeOptionalString(project?.["devServerHost"]),
    path: sanitizeOptionalString(project?.["devServerPath"]),
    https: sanitizeOptionalBoolean(project?.["devServerHttps"]),
  };

  const command = sanitizeOptionalString(source["command"]) ?? legacyValues.command;
  const cwd = sanitizeOptionalString(source["cwd"]) ?? legacyValues.cwd;
  const url = sanitizeOptionalString(source["url"]) ?? legacyValues.url;
  const port = sanitizeOptionalNumber(source["port"]) ?? legacyValues.port;
  const host = sanitizeOptionalString(source["host"]) ?? legacyValues.host;
  const path = sanitizeOptionalString(source["path"]) ?? legacyValues.path;
  const https = sanitizeOptionalBoolean(source["https"]) ?? legacyValues.https;

  if (
    command === undefined
    && cwd === undefined
    && url === undefined
    && port === undefined
    && host === undefined
    && path === undefined
    && https === undefined
  ) {
    return undefined;
  }

  const next: Record<string, unknown> = {};
  if (command !== undefined) next["command"] = command;
  if (cwd !== undefined) next["cwd"] = cwd;
  if (url !== undefined) next["url"] = url;
  if (port !== undefined) next["port"] = port;
  if (host !== undefined) next["host"] = host;
  if (path !== undefined) next["path"] = path;
  if (https !== undefined) next["https"] = https;
  return next;
}

function sanitizeAgentConfig(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const agentConfig = { ...(value as Record<string, unknown>) };
  const permissions = agentConfig["permissions"];
  if (permissions !== "skip" && permissions !== "default") {
    delete agentConfig["permissions"];
  }

  const model = sanitizeOptionalString(agentConfig["model"]);
  if (model === undefined) {
    delete agentConfig["model"];
  } else {
    agentConfig["model"] = model;
  }

  const reasoningEffort = sanitizeOptionalString(agentConfig["reasoningEffort"]);
  if (reasoningEffort === undefined) {
    delete agentConfig["reasoningEffort"];
  } else {
    agentConfig["reasoningEffort"] = reasoningEffort;
  }

  return Object.keys(agentConfig).length > 0 ? agentConfig : undefined;
}

function sanitizeProjectConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const project = { ...(value as Record<string, unknown>) };
  const optionalStringKeys = [
    "name",
    "repo",
    "path",
    "defaultBranch",
    "defaultWorkingDirectory",
    "sessionPrefix",
    "boardDir",
    "runtime",
    "agent",
    "workspace",
    "agentRules",
    "agentRulesFile",
    "defaultProfile",
    "iconUrl",
    "description",
  ] as const;

  for (const key of optionalStringKeys) {
    const sanitized = sanitizeOptionalString(project[key]);
    if (sanitized === undefined) {
      delete project[key];
    } else {
      project[key] = key === "runtime" ? normalizeRuntime(sanitized) : sanitized;
    }
  }

  const optionalObjectKeys = [
    "githubProject",
    "tracker",
    "scm",
    "reactions",
    "mcpServers",
    "agentProfiles",
  ] as const;
  for (const key of optionalObjectKeys) {
    const sanitized = sanitizePluginRef(project[key]);
    if (sanitized === undefined) {
      delete project[key];
    } else {
      project[key] = sanitized;
    }
  }

  const devServer = sanitizeDevServerConfig(project["devServer"], project);
  if (devServer) {
    project["devServer"] = devServer;
  } else {
    delete project["devServer"];
  }

  const optionalArrayKeys = [
    "symlinks",
    "postCreate",
    "setupScript",
    "cleanupScript",
    "archiveScript",
    "copyFiles",
  ] as const;
  for (const key of optionalArrayKeys) {
    if (project[key] === null) {
      delete project[key];
    }
  }

  const agentConfig = sanitizeAgentConfig(project["agentConfig"]);
  if (agentConfig) {
    project["agentConfig"] = agentConfig;
  } else {
    delete project["agentConfig"];
  }

  return project;
}

function normalizeConfigInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const normalized = { ...(raw as Record<string, unknown>) };
  const projects = normalizeProjectConfigMap(normalized["projects"]);
  normalized["projects"] = Object.fromEntries(
    Object.entries(projects).map(([projectId, project]) => [projectId, sanitizeProjectConfig(project)]),
  );
  return normalized;
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

/** Expand ~ to home directory */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Expand all path fields in the config */
function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    project.path = resolveConfiguredProjectPath(project.path, project.repo);
    if (project.devServer?.cwd) {
      project.devServer.cwd = expandHome(project.devServer.cwd);
    }
  }
  if (config.boards) {
    config.boards = config.boards.map((entry) => {
      if (typeof entry === "string") {
        return expandHome(entry);
      }
      return { ...entry, path: expandHome(entry.path) };
    });
  }
  return config;
}

/** Apply defaults to project configs */
function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    // Derive name from project ID if not set
    if (!project.name) {
      project.name = id;
    }

    // Derive session prefix from project path basename if not set
    if (!project.sessionPrefix) {
      const projectId = basename(project.path);
      project.sessionPrefix = generateSessionPrefix(projectId);
    }

    // Infer SCM from repo if not set
    if (!project.scm && project.repo.includes("/")) {
      project.scm = { plugin: "github" };
    }

    // Infer tracker from repo if not set (default to github issues)
    if (!project.tracker) {
      project.tracker = { plugin: "github" };
    }

    project.runtime = normalizeRuntime(project.runtime) ?? normalizeRuntime(config.defaults.runtime) ?? "ttyd";
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  // Check for duplicate project IDs (basenames)
  const projectIds = new Set<string>();
  const projectIdToPaths: Record<string, string[]> = {};

  for (const [_configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);

    if (!projectIdToPaths[projectId]) {
      projectIdToPaths[projectId] = [];
    }
    projectIdToPaths[projectId].push(project.path);

    if (projectIds.has(projectId)) {
      const paths = projectIdToPaths[projectId].join(", ");
      throw new Error(
        `Duplicate project ID detected: "${projectId}"\n` +
          `Multiple projects have the same directory basename:\n` +
          `  ${paths}\n\n` +
          `To fix this, ensure each project path has a unique directory name.\n` +
          `Alternatively, you can use the config key as a unique identifier.`,
      );
    }
    projectIds.add(projectId);
  }

  // Check for duplicate session prefixes
  const prefixes = new Set<string>();
  const prefixToProject: Record<string, string> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);
    const prefix = project.sessionPrefix || generateSessionPrefix(projectId);

    if (prefixes.has(prefix)) {
      const firstProjectKey = prefixToProject[prefix];
      const firstProject = config.projects[firstProjectKey];
      throw new Error(
        `Duplicate session prefix detected: "${prefix}"\n` +
          `Projects "${firstProjectKey}" and "${configKey}" would generate the same prefix.\n\n` +
          `To fix this, add an explicit sessionPrefix to one of these projects:\n\n` +
          `projects:\n` +
          `  ${firstProjectKey}:\n` +
          `    path: ${firstProject?.path}\n` +
          `    sessionPrefix: ${prefix}1  # Add explicit prefix\n` +
          `  ${configKey}:\n` +
          `    path: ${project.path}\n` +
          `    sessionPrefix: ${prefix}2  # Add explicit prefix\n`,
      );
    }

    prefixes.add(prefix);
    prefixToProject[prefix] = configKey;
  }
}

/** Apply default reactions */
function applyDefaultReactions(config: OrchestratorConfig): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
      message:
        "CI is failing on your PR. Run `gh pr checks` to see the failures, fix them, and push.",
      retries: 2,
      escalateAfter: 2,
    },
    "changes-requested": {
      auto: true,
      action: "send-to-agent",
      message:
        "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.",
      escalateAfter: "30m",
    },
    "merge-conflicts": {
      auto: true,
      action: "send-to-agent",
      message: "Your branch has merge conflicts. Rebase on the default branch and resolve them.",
      escalateAfter: "15m",
    },
    // CRITICAL: approved-and-green must NEVER auto-merge, only notify
    "approved-and-green": {
      auto: false,
      action: "notify",
      priority: "action",
      message: "PR is ready to merge",
    },
    "agent-stuck": {
      auto: true,
      action: "notify",
      priority: "urgent",
      threshold: "10m",
    },
    "agent-needs-input": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "agent-exited": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "all-complete": {
      auto: true,
      action: "notify",
      priority: "info",
      includeSummary: true,
    },
  };

  // Merge defaults with user-specified reactions (user wins)
  config.reactions = { ...defaults, ...config.reactions };

  return config;
}

/**
 * Search for config file in standard locations.
 *
 * Search order:
 * 1. CO_CONFIG_PATH environment variable (if set)
 * 2. Search up directory tree from CWD (like git)
 * 3. Explicit startDir (if provided)
 * 4. Home directory locations
 */
export function findConfigFile(startDir?: string): string | null {
  const configFiles = ["conductor.yaml", "conductor.yml"];

  const searchUpTree = (dir: string): string | null => {
    for (const filename of configFiles) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      return null;
    }

    return searchUpTree(parent);
  };

  // 1. Check environment variable override
  if (process.env["CO_CONFIG_PATH"]) {
    const envPath = resolve(process.env["CO_CONFIG_PATH"]);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Search up directory tree from explicit startDir first.
  if (startDir) {
    const foundFromStartDir = searchUpTree(resolve(startDir));
    if (foundFromStartDir) {
      return foundFromStartDir;
    }
  }

  // 3. Search up directory tree from CWD (like git)
  const foundInTree = searchUpTree(process.cwd());
  if (foundInTree) {
    return foundInTree;
  }

  // 4. Check home directory locations
  const homePaths = [
    resolve(homedir(), ".conductor.yaml"),
    resolve(homedir(), ".conductor.yml"),
    resolve(homedir(), ".config", "conductor", "config.yaml"),
  ];

  for (const path of homePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Find config file path (exported for use in hash generation) */
export function findConfig(startDir?: string): string | null {
  return findConfigFile(startDir);
}

/** Load and validate config from a YAML file */
export function loadConfig(configPath?: string): OrchestratorConfig {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error("No conductor.yaml found. Run `co setup` or `co init` to create one.");
  }

  const raw = readFileSync(path, "utf-8");
  const parsed: unknown = parseYaml(raw);
  const config = validateConfig(parsed);

  config.configPath = path;

  return config;
}

/** Load config and return both config and resolved path */
export function loadConfigWithPath(configPath?: string): {
  config: OrchestratorConfig;
  path: string;
} {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error("No conductor.yaml found. Run `co setup` or `co init` to create one.");
  }

  const raw = readFileSync(path, "utf-8");
  const parsed: unknown = parseYaml(raw);
  const config = validateConfig(parsed);

  config.configPath = path;

  return { config, path };
}

/** Validate a raw config object */
export function validateConfig(raw: unknown): OrchestratorConfig {
  const validated = ConductorConfigSchema.parse(normalizeConfigInput(raw));

  let config = validated as OrchestratorConfig;
  config = expandPaths(config);
  config = applyProjectDefaults(config);
  config = applyDefaultReactions(config);

  validateProjectUniqueness(config);

  return config;
}

/** Get the default config (useful for `co init`) */
export function getDefaultConfig(): OrchestratorConfig {
  return validateConfig({
    projects: {},
  });
}
