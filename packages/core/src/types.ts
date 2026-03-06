/**
 * Conductor v2 — Core Type Definitions
 *
 * 8 plugin slots + core services:
 *   1. Runtime    — where sessions execute (tmux)
 *   2. Agent      — AI coding tool (claude-code, codex, gemini, amp, cursor-cli, opencode, droid, qwen-code, ccr, github-copilot)
 *   3. Workspace  — code isolation (worktree)
 *   4. Tracker    — issue tracking (github)
 *   5. SCM        — source platform + PR/CI/reviews (github)
 *   6. Notifier   — push notifications (discord, desktop)
 *   7. Terminal   — human interaction UI (web)
 *   8. Lifecycle Manager (core, not pluggable)
 */

// === SESSION ===

export type SessionId = string;

export type SessionStatus =
  | "spawning"
  | "working"
  | "pr_open"
  | "ci_failed"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "mergeable"
  | "merged"
  | "cleanup"
  | "needs_input"
  | "stuck"
  | "errored"
  | "killed"
  | "done"
  | "terminated";

export type ActivityState =
  | "active"
  | "ready"
  | "idle"
  | "waiting_input"
  | "blocked"
  | "exited";

export interface ActivityDetection {
  state: ActivityState;
  timestamp?: Date;
}

/** Session status constants for safe comparisons. */
export const SESSION_STATUS = {
  SPAWNING: "spawning" as const,
  WORKING: "working" as const,
  PR_OPEN: "pr_open" as const,
  CI_FAILED: "ci_failed" as const,
  REVIEW_PENDING: "review_pending" as const,
  CHANGES_REQUESTED: "changes_requested" as const,
  APPROVED: "approved" as const,
  MERGEABLE: "mergeable" as const,
  MERGED: "merged" as const,
  CLEANUP: "cleanup" as const,
  NEEDS_INPUT: "needs_input" as const,
  STUCK: "stuck" as const,
  ERRORED: "errored" as const,
  KILLED: "killed" as const,
  DONE: "done" as const,
  TERMINATED: "terminated" as const,
} satisfies Record<string, SessionStatus>;

/** Default threshold (ms) before a "ready" session becomes "idle". */
export const DEFAULT_READY_THRESHOLD_MS = 300_000; // 5 minutes

export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "killed", "terminated", "done", "cleanup", "errored", "merged",
]);

/** Activity states that indicate the session is no longer running. */
export const TERMINAL_ACTIVITIES: ReadonlySet<ActivityState> = new Set(["exited"]);

/** Statuses that must never be restored (e.g. already merged). */
export const NON_RESTORABLE_STATUSES: ReadonlySet<SessionStatus> = new Set(["merged"]);

/** Check if a session is in a terminal (dead) state. */
export function isTerminalSession(session: {
  status: SessionStatus;
  activity: ActivityState | null;
}): boolean {
  return (
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity))
  );
}

/** Check if a session can be restored. */
export function isRestorable(session: {
  status: SessionStatus;
  activity: ActivityState | null;
}): boolean {
  return isTerminalSession(session) && !NON_RESTORABLE_STATUSES.has(session.status);
}

export interface Session {
  id: SessionId;
  projectId: string;
  status: SessionStatus;
  activity: ActivityState | null;
  branch: string | null;
  issueId: string | null;
  pr: PRInfo | null;
  workspacePath: string | null;
  runtimeHandle: RuntimeHandle | null;
  agentInfo: AgentSessionInfo | null;
  createdAt: Date;
  lastActivityAt: Date;
  restoredAt?: Date;
  metadata: Record<string, string>;
}

/** An image or file attachment referenced in a task card. */
export interface TaskAttachment {
  /** Resolved absolute path to the file. */
  path: string;
  /** Original reference text from the card (e.g. "![[mock.png]]"). */
  ref: string;
  /** File type inferred from extension. */
  type: "image" | "file";
}

export interface SessionSpawnConfig {
  projectId: string;
  issueId?: string;
  branch?: string;
  /** Optional base branch to branch from when creating a new workspace branch. */
  baseBranch?: string;
  prompt?: string;
  agent?: string;
  /** Override the model for this session (e.g. from #model/ card tag). */
  model?: string;
  /** Logical task identifier shared across attempts. */
  taskId?: string;
  /** Attempt identifier for this specific run. */
  attemptId?: string;
  /** Optional parent task ID for subtask relationships. */
  parentTaskId?: string;
  /** Optional named profile (resolved from project agentProfiles). */
  profile?: string;
  /** Session that this spawn is retrying from. */
  retryOfSessionId?: string;
  /** Image/file attachments from the task card. */
  attachments?: TaskAttachment[];
}

// === RUNTIME (Plugin Slot 1) ===

export interface Runtime {
  readonly name: string;
  create(config: RuntimeCreateConfig): Promise<RuntimeHandle>;
  destroy(handle: RuntimeHandle): Promise<void>;
  sendMessage(handle: RuntimeHandle, message: string): Promise<void>;
  getOutput(handle: RuntimeHandle, lines?: number): Promise<string>;
  isAlive(handle: RuntimeHandle): Promise<boolean>;
  getAttachInfo?(handle: RuntimeHandle): Promise<AttachInfo>;
}

export interface RuntimeCreateConfig {
  sessionId: SessionId;
  workspacePath: string;
  launchCommand: string;
  environment: Record<string, string>;
}

export interface RuntimeHandle {
  id: string;
  runtimeName: string;
  data: Record<string, unknown>;
}

export interface AttachInfo {
  type: "tmux" | "process" | "web";
  target: string;
  command?: string;
}

// === AGENT (Plugin Slot 2) ===

export interface Agent {
  readonly name: string;
  readonly processName: string;
  readonly promptDelivery?: "inline" | "post-launch";
  getLaunchCommand(config: AgentLaunchConfig): string;
  getEnvironment(config: AgentLaunchConfig): Record<string, string>;
  detectActivity(terminalOutput: string): ActivityState;
  getActivityState(session: Session, readyThresholdMs?: number): Promise<ActivityDetection | null>;
  isProcessRunning(handle: RuntimeHandle): Promise<boolean>;
  getSessionInfo(session: Session): Promise<AgentSessionInfo | null>;
  getRestoreCommand?(session: Session, project: ProjectConfig): Promise<string | null>;
  setupWorkspaceHooks?(workspacePath: string, config: WorkspaceHooksConfig): Promise<void>;
  postLaunchSetup?(session: Session): Promise<void>;
}

export interface AgentLaunchConfig {
  sessionId: SessionId;
  projectConfig: ProjectConfig;
  issueId?: string;
  prompt?: string;
  permissions?: "skip" | "default";
  model?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  /** Image/file attachments from the task card. */
  attachments?: TaskAttachment[];
  /** MCP servers to configure for this session */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Resolved workspace path for this session */
  workspacePath?: string;
}

export interface WorkspaceHooksConfig {
  dataDir: string;
  sessionId?: string;
  /** MCP servers to configure for this session */
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface AgentSessionInfo {
  summary: string | null;
  summaryIsFallback?: boolean;
  agentSessionId: string | null;
  cost?: CostEstimate;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

// === WORKSPACE (Plugin Slot 3) ===

export interface Workspace {
  readonly name: string;
  create(config: WorkspaceCreateConfig): Promise<WorkspaceInfo>;
  destroy(workspacePath: string): Promise<void>;
  list(projectId: string): Promise<WorkspaceInfo[]>;
  postCreate?(info: WorkspaceInfo, project: ProjectConfig): Promise<void>;
  exists?(workspacePath: string): Promise<boolean>;
  restore?(config: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo>;
}

export interface WorkspaceCreateConfig {
  projectId: string;
  project: ProjectConfig;
  sessionId: SessionId;
  branch: string;
  /** Base branch/ref to create the new branch from. */
  baseBranch?: string;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  sessionId: SessionId;
  projectId: string;
}

// === TRACKER (Plugin Slot 4) ===

export interface Tracker {
  readonly name: string;
  getIssue(identifier: string, project: ProjectConfig): Promise<Issue>;
  isCompleted(identifier: string, project: ProjectConfig): Promise<boolean>;
  issueUrl(identifier: string, project: ProjectConfig): string;
  branchName(identifier: string, project: ProjectConfig): string;
  generatePrompt(identifier: string, project: ProjectConfig): Promise<string>;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  url: string;
  state: "open" | "in_progress" | "closed" | "cancelled";
  labels: string[];
}

// === SCM (Plugin Slot 5) ===

export interface SCM {
  readonly name: string;
  detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null>;
  getPRState(pr: PRInfo): Promise<PRState>;
  mergePR(pr: PRInfo, method?: MergeMethod): Promise<void>;
  closePR(pr: PRInfo): Promise<void>;
  getCIChecks(pr: PRInfo): Promise<CICheck[]>;
  getCISummary(pr: PRInfo): Promise<CIStatus>;
  getReviews(pr: PRInfo): Promise<Review[]>;
  getReviewDecision(pr: PRInfo): Promise<ReviewDecision>;
  getMergeability(pr: PRInfo): Promise<MergeReadiness>;
  getDeploymentPreviewUrl?(pr: PRInfo): Promise<string | null>;
}

export interface PRInfo {
  number: number;
  url: string;
  title: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  isDraft: boolean;
}

export type PRState = "open" | "merged" | "closed";

/** PR state constants for safe comparisons. */
export const PR_STATE = {
  OPEN: "open" as const,
  MERGED: "merged" as const,
  CLOSED: "closed" as const,
} satisfies Record<string, PRState>;

export type MergeMethod = "merge" | "squash" | "rebase";

export interface CICheck {
  name: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  url?: string;
}

export type CIStatus = "pending" | "passing" | "failing" | "none";

/** CI status constants for safe comparisons. */
export const CI_STATUS = {
  PENDING: "pending" as const,
  PASSING: "passing" as const,
  FAILING: "failing" as const,
  NONE: "none" as const,
} satisfies Record<string, CIStatus>;

export interface Review {
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body?: string;
  submittedAt: Date;
}

export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";

export interface MergeReadiness {
  mergeable: boolean;
  ciPassing: boolean;
  approved: boolean;
  noConflicts: boolean;
  blockers: string[];
}

// === NOTIFIER (Plugin Slot 6) ===

export interface Notifier {
  readonly name: string;
  notify(event: OrchestratorEvent): Promise<void>;
}

// === TERMINAL (Plugin Slot 7) ===

export interface Terminal {
  readonly name: string;
  openSession(session: Session): Promise<void>;
  openAll(sessions: Session[]): Promise<void>;
}

// === EVENTS ===

export type EventPriority = "urgent" | "action" | "warning" | "info";

export type EventType =
  | "session.spawned" | "session.working" | "session.exited"
  | "session.killed" | "session.stuck" | "session.needs_input" | "session.errored"
  | "pr.created" | "pr.merged" | "pr.closed"
  | "ci.passing" | "ci.failing" | "ci.fix_sent"
  | "review.pending" | "review.approved" | "review.changes_requested"
  | "merge.ready" | "merge.completed" | "merge.conflicts"
  | "reaction.triggered" | "reaction.escalated"
  | "summary.all_complete";

export interface OrchestratorEvent {
  id: string;
  type: EventType;
  priority: EventPriority;
  sessionId: SessionId;
  projectId: string;
  timestamp: Date;
  message: string;
  data: Record<string, unknown>;
}

// === REACTIONS ===

export interface ReactionConfig {
  auto: boolean;
  action: "send-to-agent" | "notify" | "auto-merge";
  message?: string;
  priority?: EventPriority;
  retries?: number;
  escalateAfter?: number | string;
  threshold?: string;
  includeSummary?: boolean;
}

export interface ReactionResult {
  reactionType: string;
  success: boolean;
  action: string;
  message?: string;
  escalated: boolean;
}

// === CONFIGURATION ===

export interface WebhookConfig {
  enabled: boolean;
  port: number;
  secret?: string;
}

export interface NotificationPreferences {
  soundEnabled: boolean;
  soundFile: string | null;
}

export const SUPPORTED_MODEL_AGENTS = [
  "claude-code",
  "codex",
  "gemini",
  "qwen-code",
] as const;

export type SupportedModelAgent = (typeof SUPPORTED_MODEL_AGENTS)[number];
export type ClaudeModelAccess = "pro" | "max" | "api";
export type CodexModelAccess = "chatgpt" | "api";
export type GeminiModelAccess = "oauth" | "api";
export type QwenModelAccess = "oauth" | "api";
export type AgentModelAccess =
  | ClaudeModelAccess
  | CodexModelAccess
  | GeminiModelAccess
  | QwenModelAccess;

export interface ModelAccessPreferences {
  claudeCode?: ClaudeModelAccess;
  codex?: CodexModelAccess;
  gemini?: GeminiModelAccess;
  qwenCode?: QwenModelAccess;
}

export interface AgentModelAccessOption {
  id: AgentModelAccess;
  label: string;
  description: string;
}

export interface AgentModelOption {
  id: string;
  label: string;
  description: string;
  access: AgentModelAccess[];
}

export interface AgentModelCatalog {
  agent: SupportedModelAgent;
  label: string;
  accessKey: keyof ModelAccessPreferences;
  defaultAccess: AgentModelAccess;
  defaultModelByAccess: Partial<Record<AgentModelAccess, string>>;
  customModelPlaceholder: string;
  accessOptions: AgentModelAccessOption[];
  models: AgentModelOption[];
}

const DEFAULT_MODEL_ACCESS_PREFERENCES: Required<ModelAccessPreferences> = {
  claudeCode: "pro",
  codex: "chatgpt",
  gemini: "oauth",
  qwenCode: "oauth",
};

const AGENT_MODEL_CATALOGS: Record<SupportedModelAgent, AgentModelCatalog> = {
  "claude-code": {
    agent: "claude-code",
    label: "Claude Code",
    accessKey: "claudeCode",
    defaultAccess: "pro",
    defaultModelByAccess: {
      pro: "claude-sonnet-4-5",
      max: "claude-opus-4-1",
      api: "claude-sonnet-4-5",
    },
    customModelPlaceholder: "claude-sonnet-4-5",
    accessOptions: [
      {
        id: "pro",
        label: "Claude Pro",
        description: "Shows the current Sonnet models that Claude Code documents for Pro usage.",
      },
      {
        id: "max",
        label: "Claude Max",
        description: "Unlocks both Sonnet and Opus model choices in Claude Code.",
      },
      {
        id: "api",
        label: "Anthropic API",
        description: "Use direct Anthropic API credentials instead of a Claude subscription.",
      },
    ],
    models: [
      {
        id: "claude-sonnet-4-5",
        label: "Claude Sonnet 4.5",
        description: "Latest Claude Code Sonnet recommendation for most coding work.",
        access: ["pro", "max", "api"],
      },
      {
        id: "claude-sonnet-4-0",
        label: "Claude Sonnet 4",
        description: "Previous Sonnet generation kept for compatibility.",
        access: ["pro", "max", "api"],
      },
      {
        id: "claude-opus-4-1",
        label: "Claude Opus 4.1",
        description: "Higher-capability Claude Code option available on Max or API access.",
        access: ["max", "api"],
      },
      {
        id: "claude-opus-4-0",
        label: "Claude Opus 4",
        description: "Older Opus generation retained for explicit overrides.",
        access: ["max", "api"],
      },
    ],
  },
  codex: {
    agent: "codex",
    label: "Codex",
    accessKey: "codex",
    defaultAccess: "chatgpt",
    defaultModelByAccess: {
      chatgpt: "gpt-5.2-codex",
      api: "gpt-5.2-codex",
    },
    customModelPlaceholder: "gpt-5.2-codex",
    accessOptions: [
      {
        id: "chatgpt",
        label: "ChatGPT Plan",
        description: "Use the ChatGPT-backed Codex login flow for paid ChatGPT workspaces.",
      },
      {
        id: "api",
        label: "OpenAI API",
        description: "Use direct OpenAI API credentials when Codex is pointed at the API.",
      },
    ],
    models: [
      {
        id: "gpt-5.2-codex",
        label: "GPT-5.2 Codex",
        description: "Latest Codex model available in the current OpenAI model lineup.",
        access: ["chatgpt", "api"],
      },
      {
        id: "gpt-5.1-codex-max",
        label: "GPT-5.1 Codex Max",
        description: "Higher-reasoning ChatGPT Codex option documented in the Codex help center.",
        access: ["chatgpt"],
      },
      {
        id: "gpt-5.1-codex-mini",
        label: "GPT-5.1 Codex Mini",
        description: "Lower-latency ChatGPT Codex option for lighter interactive work.",
        access: ["chatgpt"],
      },
      {
        id: "gpt-5.1-codex",
        label: "GPT-5.1 Codex",
        description: "API-facing Codex model retained for compatibility with existing setups.",
        access: ["api"],
      },
    ],
  },
  gemini: {
    agent: "gemini",
    label: "Gemini",
    accessKey: "gemini",
    defaultAccess: "oauth",
    defaultModelByAccess: {
      oauth: "gemini-2.5-pro",
      api: "gemini-2.5-pro",
    },
    customModelPlaceholder: "gemini-2.5-pro",
    accessOptions: [
      {
        id: "oauth",
        label: "Google Login",
        description: "Use the built-in Google account flow that Gemini CLI ships with.",
      },
      {
        id: "api",
        label: "Gemini API",
        description: "Use a Gemini API key or Vertex AI project for broader model control.",
      },
    ],
    models: [
      {
        id: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        description: "Default Gemini CLI coding model and the safest built-in option.",
        access: ["oauth", "api"],
      },
      {
        id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        description: "Lower-latency Gemini option typically used with API-key setups.",
        access: ["api"],
      },
      {
        id: "gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash-Lite",
        description: "Cheaper Gemini API option for lightweight automation or quick checks.",
        access: ["api"],
      },
    ],
  },
  "qwen-code": {
    agent: "qwen-code",
    label: "Qwen Code",
    accessKey: "qwenCode",
    defaultAccess: "oauth",
    defaultModelByAccess: {
      oauth: "qwen3.5-plus",
      api: "qwen3-coder-plus",
    },
    customModelPlaceholder: "qwen3-coder-plus",
    accessOptions: [
      {
        id: "oauth",
        label: "Qwen OAuth",
        description: "Use Qwen Code's built-in browser login and bundled provider defaults.",
      },
      {
        id: "api",
        label: "DashScope / Custom API",
        description: "Use DashScope or another OpenAI-compatible endpoint configured for Qwen Code.",
      },
    ],
    models: [
      {
        id: "qwen3.5-plus",
        label: "Qwen3.5 Plus",
        description: "Latest bundled Qwen OAuth default documented in Qwen Code updates.",
        access: ["oauth", "api"],
      },
      {
        id: "qwen3-coder-plus",
        label: "Qwen3 Coder Plus",
        description: "Coding-focused Qwen model documented in the Qwen Code provider guide.",
        access: ["oauth", "api"],
      },
    ],
  },
};

function normalizeModelAgent(agent: string): SupportedModelAgent | null {
  const normalized = agent
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  return SUPPORTED_MODEL_AGENTS.includes(normalized as SupportedModelAgent)
    ? normalized as SupportedModelAgent
    : null;
}

export function getDefaultModelAccessPreferences(): Required<ModelAccessPreferences> {
  return { ...DEFAULT_MODEL_ACCESS_PREFERENCES };
}

export function supportsAgentModelSelection(agent: string): agent is SupportedModelAgent {
  return normalizeModelAgent(agent) !== null;
}

export function getAgentModelCatalog(agent: string): AgentModelCatalog | null {
  const normalized = normalizeModelAgent(agent);
  if (!normalized) return null;
  return AGENT_MODEL_CATALOGS[normalized];
}

export function resolveAgentModelAccess(
  agent: string,
  preferences?: ModelAccessPreferences | null,
): AgentModelAccess | null {
  const catalog = getAgentModelCatalog(agent);
  if (!catalog) return null;

  const selected = preferences?.[catalog.accessKey];
  if (
    typeof selected === "string" &&
    catalog.accessOptions.some((option) => option.id === selected)
  ) {
    return selected;
  }

  return catalog.defaultAccess;
}

export function getAvailableAgentModels(
  agent: string,
  preferences?: ModelAccessPreferences | null,
): AgentModelOption[] {
  const catalog = getAgentModelCatalog(agent);
  const access = resolveAgentModelAccess(agent, preferences);
  if (!catalog || !access) return [];

  return catalog.models.filter((model) => model.access.includes(access));
}

export function getDefaultAgentModel(
  agent: string,
  preferences?: ModelAccessPreferences | null,
): string | null {
  const catalog = getAgentModelCatalog(agent);
  const access = resolveAgentModelAccess(agent, preferences);
  if (!catalog || !access) return null;
  return catalog.defaultModelByAccess[access] ?? null;
}

export interface UserPreferences {
  /** Whether the interactive first-run setup has been completed. */
  onboardingAcknowledged: boolean;
  /** Preferred coding agent shown by default in the UI. */
  codingAgent?: string;
  /** Preferred IDE used when opening attempts/files. */
  ide?: string;
  /** Optional SSH host/alias used for remote editor deep links. */
  remoteSshHost?: string;
  /** Optional SSH username used for remote editor deep links. */
  remoteSshUser?: string;
  /** Preferred markdown editor for second-brain/context workflows. */
  markdownEditor?: string;
  /** Preferred account/access mode used to filter agent model choices in the UI. */
  modelAccess?: ModelAccessPreferences;
  notifications: NotificationPreferences;
}

export type DashboardRole = "viewer" | "operator" | "admin";
export type TrustedHeaderAccessProvider = "generic" | "cloudflare-access";

export interface DashboardRoleBindings {
  viewers?: string[];
  operators?: string[];
  admins?: string[];
  viewerDomains?: string[];
  operatorDomains?: string[];
  adminDomains?: string[];
}

export interface TrustedHeaderAccessConfig {
  enabled?: boolean;
  provider?: TrustedHeaderAccessProvider;
  emailHeader?: string;
  jwtHeader?: string;
  teamDomain?: string;
  audience?: string;
}

export interface DashboardAccessConfig {
  /** Require authenticated identity even for local access. */
  requireAuth?: boolean;
  /** Default role granted to authenticated users when no explicit binding matches. */
  defaultRole?: DashboardRole;
  /** Trust identity headers injected by an upstream edge access layer such as Cloudflare Access. */
  trustedHeaders?: TrustedHeaderAccessConfig;
  /** Optional role bindings by email or email domain. */
  roles?: DashboardRoleBindings;
}

export interface OrchestratorConfig {
  configPath: string;
  port?: number;
  terminalPort?: number;
  dashboardUrl?: string;
  boards?: BoardConfigEntry[];
  /** Global fallback column alias mapping for kanban boards. */
  columnAliases?: ColumnAliasesConfig;
  readyThresholdMs: number;
  maxSessionsPerProject: number;
  defaults: DefaultPlugins;
  projects: Record<string, ProjectConfig>;
  notifiers: Record<string, NotifierConfig>;
  notificationRouting: Record<EventPriority, string[]>;
  reactions: Record<string, ReactionConfig>;
  webhook?: WebhookConfig;
  access?: DashboardAccessConfig;
  preferences: UserPreferences;
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

export interface DefaultPlugins {
  runtime: string;
  agent: string;
  workspace: string;
  notifiers: string[];
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface AgentProfile {
  agent?: string;
  model?: string;
  permissions?: "skip" | "default";
}

export interface DevServerConfig {
  command: string;
  cwd?: string;
}

export interface ColumnAliasesConfig {
  intake?: string[];
  ready?: string[];
  dispatching?: string[];
  inProgress?: string[];
  review?: string[];
  done?: string[];
  blocked?: string[];
}

export interface BoardConfigObject {
  path: string;
  aliases?: ColumnAliasesConfig;
}

export type BoardConfigEntry = string | BoardConfigObject;

export interface ProjectConfig {
  name: string;
  repo: string;
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
  /** Optional subdirectory (relative to repo root) where the agent runtime starts. */
  defaultWorkingDirectory?: string;
  /** Maps this project to an Obsidian board directory name (when dir name != config key). */
  boardDir?: string;
  runtime?: string;
  agent?: string;
  workspace?: string;
  tracker?: TrackerConfig;
  scm?: SCMConfig;
  symlinks?: string[];
  postCreate?: string[];
  /** Setup commands run after workspace creation and before/with agent startup. */
  setupScript?: string[];
  /** When true, setup runs in background while agent starts. */
  runSetupInParallel?: boolean;
  /** Cleanup commands run before archiving a workspace when changes exist. */
  cleanupScript?: string[];
  /** Archive commands run when a workspace/session is archived. */
  archiveScript?: string[];
  /** Relative file paths or glob patterns copied from repo root into worktree. */
  copyFiles?: string[];
  agentConfig?: AgentSpecificConfig;
  reactions?: Record<string, Partial<ReactionConfig>>;
  agentRules?: string;
  agentRulesFile?: string;
  /** MCP servers available to agents in this project */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Named profile presets (fast/deep/safe/auto etc.) for this project. */
  agentProfiles?: Record<string, AgentProfile>;
  /** Default profile used when a task does not specify #profile/<name>. */
  defaultProfile?: string;
  /** Optional dev server command for preview/test workflows. */
  devServer?: DevServerConfig;
}

export interface TrackerConfig {
  plugin: string;
  [key: string]: unknown;
}

export interface SCMConfig {
  plugin: string;
  [key: string]: unknown;
}

export interface NotifierConfig {
  plugin: string;
  [key: string]: unknown;
}

export interface AgentSpecificConfig {
  permissions?: "skip" | "default";
  model?: string;
  [key: string]: unknown;
}

// === PLUGIN SYSTEM ===

export type PluginSlot =
  | "runtime" | "agent" | "workspace"
  | "tracker" | "scm" | "notifier" | "terminal";

export interface PluginManifest {
  name: string;
  slot: PluginSlot;
  description: string;
  version: string;
}

export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;
}

// === SESSION METADATA (flat file) ===

export interface SessionMetadata {
  worktree: string;
  branch: string;
  status: string;
  tmuxName?: string;
  issue?: string;
  pr?: string;
  summary?: string;
  project?: string;
  agent?: string;
  createdAt?: string;
  runtimeHandle?: string;
  restoredAt?: string;
  role?: string;
  /** Persisted CI status from lifecycle SCM polling. */
  ciStatus?: string;
  /** Persisted review decision from lifecycle SCM polling. */
  reviewDecision?: string;
  /** Persisted PR state (open/merged/closed) from lifecycle SCM polling. */
  prState?: string;
  /** JSON-serialized MergeReadiness from lifecycle SCM polling. */
  mergeReadiness?: string;
  /** Enriched PR title (from gh pr view). */
  prTitle?: string;
  /** Enriched PR head branch/ref name. */
  prHeadRef?: string;
  /** Enriched PR base branch/ref name. */
  prBaseRef?: string;
  /** Enriched PR draft flag ("1" or "0"). */
  prDraft?: string;
  /** JSON-serialized CostEstimate from agent plugin. */
  cost?: string;
  /** Model used by the session's agent plugin. */
  model?: string;
  /** Agent execution permission mode. */
  permissions?: "skip" | "default";
  /** Logical task identifier shared across retries/attempts. */
  taskId?: string;
  /** Attempt identifier for this run. */
  attemptId?: string;
  /** Parent task ID for subtask lineage. */
  parentTaskId?: string;
  /** Attempt state marker (active/archived/superseded). */
  attemptStatus?: string;
  /** Previous session this attempt retried from. */
  retryOfSessionId?: string;
  /** Attempt ID superseding this attempt. */
  supersededByAttemptId?: string;
  /** Named profile used for this session. */
  profile?: string;
  /** Base branch used for branch creation. */
  baseBranch?: string;
  /** Persisted prompt text used at spawn time. */
  prompt?: string;
  /** Dev server log file associated with this session, if configured. */
  devServerLog?: string;
}

// === SERVICE INTERFACES ===

export interface RetryConfig {
  agent?: string;
  model?: string;
  baseBranch?: string;
  profile?: string;
}

export interface AttemptSummary {
  attemptId: string;
  sessionId: string;
  status: SessionStatus;
  agent?: string;
  model?: string;
  branch?: string | null;
  createdAt: Date;
}

export interface TaskGraph {
  taskId: string;
  parentTaskId: string | null;
  childrenTaskIds: string[];
  attempts: AttemptSummary[];
}

export interface SessionManager {
  spawn(config: SessionSpawnConfig): Promise<Session>;
  list(projectId?: string): Promise<Session[]>;
  get(sessionId: SessionId): Promise<Session | null>;
  retry(target: string, options?: RetryConfig): Promise<Session>;
  taskGraph(taskId: string): Promise<TaskGraph | null>;
  submitFeedback(sessionId: SessionId, feedback: string): Promise<void>;
  kill(sessionId: SessionId): Promise<void>;
  cleanup(projectId?: string, options?: { dryRun?: boolean }): Promise<CleanupResult>;
  send(sessionId: SessionId, message: string): Promise<void>;
  restore(sessionId: SessionId): Promise<Session>;
  /** Capture terminal output (last N lines from the runtime pane). */
  getOutput(sessionId: SessionId, lines?: number): Promise<string>;
}

export interface CleanupResult {
  killed: string[];
  skipped: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

export interface LifecycleManager {
  start(intervalMs?: number): void;
  stop(): void;
  getStates(): Map<SessionId, SessionStatus>;
  check(sessionId: SessionId): Promise<void>;
}

export interface PluginRegistry {
  register(plugin: PluginModule, config?: Record<string, unknown>): void;
  get<T>(slot: PluginSlot, name: string): T | null;
  list(slot: PluginSlot): PluginManifest[];
  loadBuiltins(
    config?: OrchestratorConfig,
    importFn?: (pkg: string) => Promise<unknown>,
  ): Promise<void>;
}

// === UTILITY ===

export function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// === ERROR HELPERS ===

/**
 * Detect if an error indicates that an issue was not found in the tracker.
 * Uses specific patterns to avoid matching infrastructure errors.
 */
export function isIssueNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = (err as Error).message?.toLowerCase() || "";
  return (
    (message.includes("issue") &&
      (message.includes("not found") || message.includes("does not exist"))) ||
    message.includes("no issue found") ||
    message.includes("could not find issue") ||
    message.includes("could not resolve to an issue") ||
    message.includes("no issue with identifier") ||
    message.includes("invalid issue format")
  );
}

/** Thrown when a session cannot be restored. */
export class SessionNotRestorableError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly reason: string,
  ) {
    super(`Session ${sessionId} cannot be restored: ${reason}`);
    this.name = "SessionNotRestorableError";
  }
}

/** Thrown when a workspace is missing and cannot be recreated. */
export class WorkspaceMissingError extends Error {
  constructor(
    public readonly path: string,
    public readonly detail?: string,
  ) {
    super(`Workspace missing at ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "WorkspaceMissingError";
  }
}
