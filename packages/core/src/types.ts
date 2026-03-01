/**
 * Conductor v2 — Core Type Definitions
 *
 * 8 plugin slots + core services:
 *   1. Runtime    — where sessions execute (tmux)
 *   2. Agent      — AI coding tool (claude-code, codex)
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
  prompt?: string;
  agent?: string;
  /** Override the model for this session (e.g. from #model/ card tag). */
  model?: string;
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

export interface OrchestratorConfig {
  configPath: string;
  port?: number;
  terminalPort?: number;
  dashboardUrl?: string;
  readyThresholdMs: number;
  maxSessionsPerProject: number;
  defaults: DefaultPlugins;
  projects: Record<string, ProjectConfig>;
  notifiers: Record<string, NotifierConfig>;
  notificationRouting: Record<EventPriority, string[]>;
  reactions: Record<string, ReactionConfig>;
  webhook?: WebhookConfig;
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

export interface ProjectConfig {
  name: string;
  repo: string;
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
  /** Maps this project to an Obsidian board directory name (when dir name != config key). */
  boardDir?: string;
  runtime?: string;
  agent?: string;
  workspace?: string;
  tracker?: TrackerConfig;
  scm?: SCMConfig;
  symlinks?: string[];
  postCreate?: string[];
  agentConfig?: AgentSpecificConfig;
  reactions?: Record<string, Partial<ReactionConfig>>;
  agentRules?: string;
  agentRulesFile?: string;
  /** MCP servers available to agents in this project */
  mcpServers?: Record<string, MCPServerConfig>;
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
}

// === SERVICE INTERFACES ===

export interface SessionManager {
  spawn(config: SessionSpawnConfig): Promise<Session>;
  list(projectId?: string): Promise<Session[]>;
  get(sessionId: SessionId): Promise<Session | null>;
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
