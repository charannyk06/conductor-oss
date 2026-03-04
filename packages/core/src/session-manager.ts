/**
 * Session Manager -- CRUD for agent sessions.
 *
 * Orchestrates Runtime, Agent, and Workspace plugins to:
 * - Spawn new sessions (create workspace -> create runtime -> launch agent)
 * - List sessions (from metadata + live runtime checks)
 * - Kill sessions (agent -> runtime -> workspace cleanup)
 * - Cleanup completed sessions (PR merged / issue closed)
 * - Send messages to running sessions
 * - Restore dead sessions
 *
 * Enforces max 5 sessions per project.
 */

import { statSync, existsSync, rmSync, mkdirSync, createWriteStream } from "node:fs";
import { join, basename, dirname } from "node:path";
import { execFile, spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import {
  isIssueNotFoundError,
  isRestorable,
  NON_RESTORABLE_STATUSES,
  SessionNotRestorableError,
  WorkspaceMissingError,
  PR_STATE,
  type SessionManager,
  type Session,
  type SessionId,
  type SessionSpawnConfig,
  type SessionStatus,
  type CleanupResult,
  type RetryConfig,
  type TaskGraph,
  type AttemptSummary,
  type OrchestratorConfig,
  type ProjectConfig,
  type Runtime,
  type Agent,
  type Workspace,
  type Tracker,
  type SCM,
  type PluginRegistry,
  type RuntimeHandle,
  type Issue,
} from "./types.js";
import {
  readMetadataRaw,
  readArchivedMetadataRaw,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  reserveSessionId,
} from "./metadata.js";
import { buildPrompt } from "./prompt-builder.js";
import {
  getSessionsDir,
  generateTmuxName,
  validateAndStoreOrigin,
} from "./paths.js";
import { normalizeAgentName } from "./agent-names.js";

const execFileP = promisify(execFile);

/** Direct worktree cleanup fallback when workspace plugin isn't loaded. */
async function directWorktreeCleanup(
  worktreePath: string,
  project: ProjectConfig | undefined,
  sessionId: string,
): Promise<void> {
  // Resolve the main repo path
  let repoPath: string | null = null;
  if (project) {
    const p = project.path.startsWith("~/")
      ? join(homedir(), project.path.slice(2))
      : project.path;
    if (existsSync(join(p, ".git"))) repoPath = p;
  }
  if (!repoPath) {
    // Infer from worktree path: ~/.worktrees/{projectId}/{sessionId}
    const projectId = basename(dirname(worktreePath));
    const inferred = join(homedir(), ".conductor", "projects", projectId);
    if (existsSync(join(inferred, ".git"))) repoPath = inferred;
  }

  if (repoPath) {
    try {
      await execFileP("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repoPath,
        timeout: 15_000,
      });
    } catch {
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }
    try {
      await execFileP("git", ["worktree", "prune"], { cwd: repoPath, timeout: 10_000 });
    } catch { /* best effort */ }
    // Delete session branch
    const branchName = `session/${sessionId}`;
    try {
      await execFileP("git", ["branch", "-D", branchName], { cwd: repoPath, timeout: 10_000 });
    } catch { /* branch may not exist */ }
  } else {
    // No repo found — just nuke the directory
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }
}

/** Max sessions per project -- hard limit enforced at spawn time. */
const MAX_SESSIONS_PER_PROJECT = 5;

/** Escape regex metacharacters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Common stop words to skip when slugifying prompts. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "it", "its", "this", "that", "using", "use", "via", "into", "as",
]);

/**
 * Generate a short kebab-case slug from a prompt.
 * Extracts 2-4 meaningful words, lowercase, max 30 chars total.
 */
function slugifyPrompt(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  // Take first 3-4 meaningful words, max 30 chars
  const parts: string[] = [];
  let len = 0;
  for (const w of words) {
    if (parts.length >= 4) break;
    if (len + w.length + 1 > 30) break;
    parts.push(w);
    len += w.length + 1;
  }

  return parts.join("-") || "task";
}

/** Get the next session number for a project. Matches {prefix}-{anything}-{num} or {prefix}-{num}. */
function getNextSessionNumber(existingSessions: string[], prefix: string): number {
  let max = 0;
  // Match both old format (pp-3) and new format (pp-netlify-env-3)
  const pattern = new RegExp(`^${escapeRegex(prefix)}-(?:.*?-)??(\\d+)$`);
  for (const name of existingSessions) {
    const match = name.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

/** Safely parse JSON, returning null on failure. */
function safeJsonParse<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

/** Valid session statuses for validation. */
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "spawning", "working", "pr_open", "ci_failed", "review_pending",
  "changes_requested", "approved", "mergeable", "merged", "cleanup",
  "needs_input", "stuck", "errored", "killed", "done", "terminated",
]);

/** Validate and normalize a status string. */
function validateStatus(raw: string | undefined): SessionStatus {
  if (raw === "starting") return "working";
  if (raw && VALID_STATUSES.has(raw)) return raw as SessionStatus;
  return "spawning";
}

/** Reconstruct a Session object from raw metadata key=value pairs. */
function metadataToSession(
  sessionId: SessionId,
  meta: Record<string, string>,
  createdAt?: Date,
  modifiedAt?: Date,
  fallbackProjectId?: string,
): Session {
  return {
    id: sessionId,
    projectId: meta["project"] ?? fallbackProjectId ?? "",
    status: validateStatus(meta["status"]),
    activity: null,
    branch: meta["branch"] || null,
    issueId: meta["issue"] || null,
    pr: meta["pr"]
      ? (() => {
          const prUrl = meta["pr"];
          const ghMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
          return {
            number: ghMatch
              ? parseInt(ghMatch[3], 10)
              : parseInt(prUrl.match(/\/(\d+)$/)?.[1] ?? "0", 10),
            url: prUrl,
            title: meta["prTitle"] ?? "",
            owner: ghMatch?.[1] ?? "",
            repo: ghMatch?.[2] ?? "",
            branch: meta["prHeadRef"] ?? meta["branch"] ?? "",
            baseBranch: meta["prBaseRef"] ?? "",
            isDraft: meta["prDraft"] === "1" || meta["prDraft"] === "true",
          };
        })()
      : null,
    workspacePath: meta["worktree"] || null,
    runtimeHandle: meta["runtimeHandle"]
      ? safeJsonParse<RuntimeHandle>(meta["runtimeHandle"])
      : null,
    agentInfo: meta["summary"] || meta["cost"]
      ? {
          summary: meta["summary"] ?? null,
          agentSessionId: null,
          ...(meta["cost"] ? { cost: safeJsonParse(meta["cost"]) ?? undefined } : {}),
        }
      : null,
    createdAt: meta["createdAt"] ? new Date(meta["createdAt"]) : (createdAt ?? new Date()),
    lastActivityAt: modifiedAt ?? new Date(),
    metadata: meta,
  };
}

export interface SessionManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
}

/** Create a SessionManager instance. */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { config, registry } = deps;

  /** Effective max sessions from config or hardcoded default. */
  const maxSessions = config.maxSessionsPerProject ?? MAX_SESSIONS_PER_PROJECT;

  /** Get the sessions directory for a project. */
  function getProjectSessionsDir(project: ProjectConfig): string {
    return getSessionsDir(config.configPath, project.path);
  }

  /**
   * List all session files across all projects (or filtered by projectId).
   * Scans project-specific directories under ~/.conductor/{hash}-{projectId}/sessions/
   */
  function listAllSessions(projectIdFilter?: string): { sessionName: string; projectId: string }[] {
    const results: { sessionName: string; projectId: string }[] = [];

    for (const [projectKey, project] of Object.entries(config.projects)) {
      const projectId = projectKey;
      if (projectIdFilter && projectId !== projectIdFilter) continue;

      const sessionsDir = getSessionsDir(config.configPath, project.path);
      if (!existsSync(sessionsDir)) continue;

      const sessionNames = listMetadata(sessionsDir);
      for (const name of sessionNames) {
        results.push({ sessionName: name, projectId });
      }
    }

    return results;
  }

  interface SessionLocation {
    sessionId: string;
    projectId: string;
    project: ProjectConfig;
    sessionsDir: string;
    raw: Record<string, string>;
  }

  function findSessionLocation(sessionId: string): SessionLocation | null {
    for (const [projectId, project] of Object.entries(config.projects)) {
      const sessionsDir = getProjectSessionsDir(project);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;
      return { sessionId, projectId, project, sessionsDir, raw };
    }
    return null;
  }

  function listSessionLocations(projectIdFilter?: string): SessionLocation[] {
    const out: SessionLocation[] = [];
    for (const [projectId, project] of Object.entries(config.projects)) {
      if (projectIdFilter && projectId !== projectIdFilter) continue;
      const sessionsDir = getProjectSessionsDir(project);
      if (!existsSync(sessionsDir)) continue;
      for (const sessionName of listMetadata(sessionsDir)) {
        const raw = readMetadataRaw(sessionsDir, sessionName);
        if (!raw) continue;
        out.push({ sessionId: sessionName, projectId, project, sessionsDir, raw });
      }
    }
    return out;
  }

  function generateAttemptId(): string {
    return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function resolveParentBaseBranch(projectId: string, parentTaskId: string): string | undefined {
    const locations = listSessionLocations(projectId)
      .filter((loc) => loc.raw["taskId"] === parentTaskId && !!loc.raw["branch"])
      .sort((a, b) => {
        const aTs = Date.parse(a.raw["createdAt"] ?? "") || 0;
        const bTs = Date.parse(b.raw["createdAt"] ?? "") || 0;
        return bTs - aTs;
      });
    return locations[0]?.raw["branch"];
  }

  function resolveProfile(
    project: ProjectConfig,
    spawnConfig: SessionSpawnConfig,
  ): {
    profileName?: string;
    agentName: string;
    model?: string;
    permissions: "skip" | "default";
  } {
    const profileName = spawnConfig.profile ?? project.defaultProfile;
    const profile = profileName ? project.agentProfiles?.[profileName] : undefined;
    const agentName = normalizeAgentName(
      spawnConfig.agent ?? profile?.agent ?? project.agent ?? config.defaults.agent,
    );
    const model = spawnConfig.model
      ?? (!spawnConfig.agent ? profile?.model : undefined)
      ?? project.agentConfig?.model;
    const permissions = profile?.permissions ?? project.agentConfig?.permissions ?? "skip";
    return { profileName, agentName, model, permissions };
  }

  const devServerByProject = new Map<string, { process: ChildProcess; logPath: string }>();

  function ensureDevServer(projectId: string, project: ProjectConfig): string | null {
    const dev = project.devServer;
    if (!dev?.command) return null;

    const existing = devServerByProject.get(projectId);
    if (existing && !existing.process.killed) {
      return existing.logPath;
    }

    const logDir = join(homedir(), ".conductor", "dev-servers");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `${projectId}.log`);
    const stream = createWriteStream(logPath, { flags: "a" });

    const child = spawnProcess("sh", ["-lc", dev.command], {
      cwd: dev.cwd ?? project.path,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
    child.unref();

    devServerByProject.set(projectId, { process: child, logPath });
    return logPath;
  }

  /** Count active (non-terminal) sessions for a project. */
  function countActiveSessions(projectId: string): number {
    const project = config.projects[projectId];
    if (!project) return 0;

    const sessionsDir = getProjectSessionsDir(project);
    const sessionNames = listMetadata(sessionsDir);
    let count = 0;

    for (const name of sessionNames) {
      const raw = readMetadataRaw(sessionsDir, name);
      if (!raw) continue;
      const status = validateStatus(raw["status"]);
      // Count sessions that are not in terminal states
      const terminalStatuses = new Set(["killed", "terminated", "done", "cleanup", "errored", "merged"]);
      if (!terminalStatuses.has(status)) {
        count++;
      }
    }

    return count;
  }

  /** Resolve which plugins to use for a project. */
  function resolvePlugins(project: ProjectConfig, agentOverride?: string) {
    const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
    const requestedAgent = normalizeAgentName(agentOverride ?? project.agent ?? config.defaults.agent);
    const agent = registry.get<Agent>("agent", requestedAgent);
    const workspace = registry.get<Workspace>(
      "workspace",
      project.workspace ?? config.defaults.workspace,
    );
    const tracker = project.tracker
      ? registry.get<Tracker>("tracker", project.tracker.plugin)
      : null;
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    return { runtime, agent, workspace, tracker, scm };
  }

  /**
   * Ensure session has a runtime handle (fabricate one if missing) and enrich
   * with live runtime state + activity detection.
   */
  async function ensureHandleAndEnrich(
    session: Session,
    sessionName: string,
    project: ProjectConfig,
    plugins: ReturnType<typeof resolvePlugins>,
  ): Promise<void> {
    const handleFromMetadata = session.runtimeHandle !== null;
    if (!handleFromMetadata) {
      session.runtimeHandle = {
        id: sessionName,
        runtimeName: project.runtime ?? config.defaults.runtime,
        data: {},
      };
    }
    await enrichSessionWithRuntimeState(session, plugins, handleFromMetadata);
  }

  /** Terminal session statuses -- skip subprocess/IO work for these. */
  const TERMINAL_SESSION_STATUSES = new Set([
    "killed", "done", "merged", "terminated", "cleanup",
  ]);

  /**
   * Enrich session with live runtime state and activity detection.
   * Mutates the session object in place.
   */
  async function enrichSessionWithRuntimeState(
    session: Session,
    plugins: ReturnType<typeof resolvePlugins>,
    handleFromMetadata: boolean,
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      if (
        session.status === "done" &&
        handleFromMetadata &&
        session.runtimeHandle &&
        plugins.runtime &&
        session.metadata["attemptStatus"] !== "archived"
      ) {
        try {
          const alive = await plugins.runtime.isAlive(session.runtimeHandle);
          if (alive) {
            session.status = "working";
            if (project) {
              const sessionsDir = getProjectSessionsDir(project);
              updateMetadata(sessionsDir, session.id, { status: "working" });
            }
          } else {
            session.activity = "exited";
            return;
          }
        } catch {
          session.activity = "exited";
          return;
        }
      } else {
        session.activity = "exited";
        // Still fetch session info (summary, cost) for done sessions — the
        // JSONL files persist on disk and may contain real summaries even
        // after the agent process has exited.
        if (plugins.agent) {
          try {
            const info = await plugins.agent.getSessionInfo(session);
            if (info) {
              session.agentInfo = info;
              // Persist to metadata if the summary is a real one (not a fallback)
              if (info.summary && !info.summaryIsFallback) {
                if (project) {
                  const sessionsDir = getProjectSessionsDir(project);
                  const fields: Record<string, string> = {};
                  fields["summary"] = info.summary;
                  if (info.cost) fields["cost"] = JSON.stringify(info.cost);
                  updateMetadata(sessionsDir, session.id, fields);
                }
              }
            }
          } catch {
            // Can't get session info — use metadata fallback
          }
        }
        return;
      }

      if (session.status !== "working") {
        return;
      }
    }

    // Check runtime liveness only if handle came from metadata
    if (handleFromMetadata && session.runtimeHandle && plugins.runtime) {
      try {
        const alive = await plugins.runtime.isAlive(session.runtimeHandle);
        if (!alive) {
          session.status = "killed";
          session.activity = "exited";
          return;
        }
      } catch {
        // Can't check liveness -- continue to activity detection
      }
    }

    // Detect activity independently of runtime handle
    if (plugins.agent) {
      try {
        const detected = await plugins.agent.getActivityState(session, config.readyThresholdMs);
        if (detected !== null) {
          session.activity = detected.state;
          if (detected.timestamp && detected.timestamp > session.lastActivityAt) {
            session.lastActivityAt = detected.timestamp;
          }
        }
      } catch {
        // Can't detect activity -- keep existing value
      }

      // Enrich with live agent session info (summary, cost) and persist to metadata
      try {
        const info = await plugins.agent.getSessionInfo(session);
        if (info) {
          session.agentInfo = info;
          // Persist to metadata for durability across restarts
          const project = config.projects[session.projectId];
          if (project) {
            const sessionsDir = getProjectSessionsDir(project);
            const fields: Record<string, string> = {};
            if (info.summary) fields["summary"] = info.summary;
            if (info.cost) fields["cost"] = JSON.stringify(info.cost);
            if (Object.keys(fields).length > 0) {
              updateMetadata(sessionsDir, session.id, fields);
            }
          }
        }
      } catch {
        // Can't get session info -- keep existing values
      }
    }
  }

  async function spawn(spawnConfig: SessionSpawnConfig): Promise<Session> {
    const project = config.projects[spawnConfig.projectId];
    if (!project) {
      throw new Error(`Unknown project: ${spawnConfig.projectId}`);
    }

    // Enforce max sessions per project
    const activeCount = countActiveSessions(spawnConfig.projectId);
    if (activeCount >= maxSessions) {
      throw new Error(
        `Project "${spawnConfig.projectId}" already has ${activeCount} active sessions ` +
          `(max ${maxSessions}). Kill or cleanup existing sessions first.`,
      );
    }

    const profileSelection = resolveProfile(project, spawnConfig);
    const plugins = resolvePlugins(project, profileSelection.agentName);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }

    if (!plugins.agent) {
      throw new Error(`Agent plugin '${profileSelection.agentName}' not found`);
    }

    // Validate issue exists BEFORE creating any resources
    let resolvedIssue: Issue | undefined;
    if (spawnConfig.issueId && plugins.tracker) {
      try {
        resolvedIssue = await plugins.tracker.getIssue(spawnConfig.issueId, project);
      } catch (err) {
        if (isIssueNotFoundError(err)) {
          // Ad-hoc issue string -- proceed without tracker context
        } else {
          throw new Error(`Failed to fetch issue ${spawnConfig.issueId}: ${err}`, { cause: err });
        }
      }
    }

    // Get the sessions directory for this project
    const sessionsDir = getProjectSessionsDir(project);

    // Validate and store .origin file
    if (config.configPath) {
      validateAndStoreOrigin(config.configPath, project.path);
    }

    // Determine session ID -- atomically reserve to prevent concurrent collisions
    // Format: {prefix}-{slug}-{num} e.g. pp-netlify-env-3
    const existingSessions = listMetadata(sessionsDir);
    let num = getNextSessionNumber(existingSessions, project.sessionPrefix);
    const promptText = spawnConfig.prompt ?? spawnConfig.issueId ?? "";
    const slug = slugifyPrompt(promptText);
    let sessionId: string;
    let tmuxName: string | undefined;
    for (let attempts = 0; attempts < 10; attempts++) {
      sessionId = `${project.sessionPrefix}-${slug}-${num}`;
      if (config.configPath) {
        tmuxName = generateTmuxName(config.configPath, `${project.sessionPrefix}-${slug}`, num);
      }
      if (reserveSessionId(sessionsDir, sessionId)) break;
      num++;
      if (attempts === 9) {
        throw new Error(
          `Failed to reserve session ID after 10 attempts (prefix: ${project.sessionPrefix})`,
        );
      }
    }
    // Reassign to satisfy TypeScript's flow analysis
    sessionId = `${project.sessionPrefix}-${slug}-${num}`;
    if (config.configPath) {
      tmuxName = generateTmuxName(config.configPath, `${project.sessionPrefix}-${slug}`, num);
    }

    const taskId = spawnConfig.taskId ?? `t-${sessionId}`;
    const attemptId = spawnConfig.attemptId ?? `a-${sessionId}`;
    const parentTaskId = spawnConfig.parentTaskId;
    const baseBranch = spawnConfig.baseBranch
      ?? (parentTaskId ? resolveParentBaseBranch(spawnConfig.projectId, parentTaskId) : undefined)
      ?? project.defaultBranch;

    // Determine branch name
    let branch: string;
    if (spawnConfig.branch) {
      branch = spawnConfig.branch;
    } else if (spawnConfig.issueId && plugins.tracker && resolvedIssue) {
      branch = plugins.tracker.branchName(spawnConfig.issueId, project);
    } else if (spawnConfig.issueId) {
      const id = spawnConfig.issueId;
      const isBranchSafe =
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
      const slug = isBranchSafe
        ? id
        : id
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 60)
            .replace(/^-+|-+$/g, "");
      branch = `feat/${slug || sessionId}`;
    } else {
      const taskSlug = taskId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40);
      const attemptSlug = attemptId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 20);
      branch = `task/${taskSlug}-${attemptSlug}`;
    }

    // Create workspace (if workspace plugin is available)
    let workspacePath = project.path;
    if (plugins.workspace) {
      try {
        const wsInfo = await plugins.workspace.create({
          projectId: spawnConfig.projectId,
          project,
          sessionId,
          branch,
          baseBranch,
        });
        workspacePath = wsInfo.path;

        // Run post-create hooks -- clean up workspace on failure
        if (plugins.workspace.postCreate) {
          try {
            await plugins.workspace.postCreate(wsInfo, project);
          } catch (err) {
            if (workspacePath !== project.path) {
              try {
                await plugins.workspace.destroy(workspacePath);
              } catch {
                /* best effort */
              }
            }
            throw err;
          }
        }
      } catch (err) {
        // Clean up reserved session ID on workspace failure
        try {
          deleteMetadata(sessionsDir, sessionId, false);
        } catch {
          /* best effort */
        }
        throw err;
      }
    }

    // Generate prompt with validated issue
    let issueContext: string | undefined;
    if (spawnConfig.issueId && plugins.tracker && resolvedIssue) {
      try {
        issueContext = await plugins.tracker.generatePrompt(spawnConfig.issueId, project);
      } catch {
        // Non-fatal: continue without detailed issue context
      }
    }

    const composedPrompt = buildPrompt({
      project,
      projectId: spawnConfig.projectId,
      issueId: spawnConfig.issueId,
      issueContext,
      userPrompt: spawnConfig.prompt,
      attachments: spawnConfig.attachments,
    });

    // Merge default MCP servers with project-specific ones (project overrides defaults)
    const mergedMcpServers = {
      ...config.defaults.mcpServers,
      ...project.mcpServers,
    };
    const resolvedMcpServers =
      Object.keys(mergedMcpServers).length > 0 ? mergedMcpServers : undefined;

    // Get agent launch config and create runtime -- clean up workspace on failure
    // When agent is overridden via #agent/ tag, don't leak the project's model
    // to the wrong CLI (e.g. passing claude-opus-4-6 to codex would crash).
    // Each agent plugin has its own default model as fallback.
    const agentLaunchConfig = {
      sessionId,
      projectConfig: project,
      issueId: spawnConfig.issueId,
      prompt: composedPrompt ?? spawnConfig.prompt,
      permissions: profileSelection.permissions,
      model: profileSelection.model,
      attachments: spawnConfig.attachments,
      mcpServers: resolvedMcpServers,
      workspacePath,
    };

    let handle: RuntimeHandle;
    try {
      // Set up workspace hooks (writes MCP config files, shell wrappers, etc.)
      // Must run before getLaunchCommand so MCP config files exist when referenced.
      if (plugins.agent.setupWorkspaceHooks) {
        await plugins.agent.setupWorkspaceHooks(workspacePath, {
          dataDir: sessionsDir,
          sessionId,
          mcpServers: resolvedMcpServers,
        });
      }

      const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
      const environment = plugins.agent.getEnvironment(agentLaunchConfig);

      handle = await plugins.runtime.create({
        sessionId: tmuxName ?? sessionId,
        workspacePath,
        launchCommand,
        environment: {
          ...environment,
          CO_SESSION: sessionId,
          CO_DATA_DIR: sessionsDir,
          CO_SESSION_NAME: sessionId,
          ...(tmuxName && { CO_TMUX_NAME: tmuxName }),
        },
      });
    } catch (err) {
      // Clean up workspace and reserved ID if runtime creation failed
      if (plugins.workspace && workspacePath !== project.path) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(sessionsDir, sessionId, false);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Write metadata and run post-launch setup -- clean up on failure
    const session: Session = {
      id: sessionId,
      projectId: spawnConfig.projectId,
      status: "spawning",
      activity: "active",
      branch,
      issueId: spawnConfig.issueId ?? null,
      pr: null,
      workspacePath,
      runtimeHandle: handle,
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    };
    const devServerLog = ensureDevServer(spawnConfig.projectId, project);

    try {
      writeMetadata(sessionsDir, sessionId, {
        worktree: workspacePath,
        branch,
        status: "spawning",
        tmuxName,
        issue: spawnConfig.issueId,
        project: spawnConfig.projectId,
        agent: plugins.agent.name,
        model: profileSelection.model,
        permissions: profileSelection.permissions,
        profile: profileSelection.profileName,
        taskId,
        attemptId,
        parentTaskId,
        attemptStatus: "active",
        retryOfSessionId: spawnConfig.retryOfSessionId,
        baseBranch,
        prompt: spawnConfig.prompt ?? composedPrompt ?? undefined,
        createdAt: new Date().toISOString(),
        runtimeHandle: JSON.stringify(handle),
      });
      updateMetadata(sessionsDir, sessionId, {
        devServerLog: devServerLog ?? "",
      });

      if (plugins.agent.postLaunchSetup) {
        await plugins.agent.postLaunchSetup(session);
      }
    } catch (err) {
      // Clean up runtime and workspace on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
      } catch {
        /* best effort */
      }
      if (plugins.workspace && workspacePath !== project.path) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(sessionsDir, sessionId, false);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Send initial prompt post-launch for agents that need it. This runs
    // asynchronously so spawn() returns immediately and the UI can transition
    // to the workspace without waiting for CLI readiness probing.
    if (plugins.agent.promptDelivery === "post-launch" && agentLaunchConfig.prompt) {
      const runtime = plugins.runtime;
      const initialPrompt = agentLaunchConfig.prompt;
      if (!runtime || !initialPrompt) return session;

      void (async () => {
        try {
          const maxWaitMs = 90_000;
          const pollIntervalMs = 1_000;
          const startTime = Date.now();
          let ready = false;

          // Wait at least 3s for the process to start
          await new Promise((resolve) => setTimeout(resolve, 3_000));

          while (Date.now() - startTime < maxWaitMs) {
            try {
              const output = await runtime.getOutput(handle, 20);
              // Claude Code shows "❯" when ready for input
              // Codex shows ">" or "$" when ready
              if (/[❯>$]\s*$/.test(output.trim()) || /Try "/.test(output)) {
                ready = true;
                break;
              }
            } catch {
              // Can't read output -- keep trying
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }

          if (!ready) {
            console.log(`[session-manager] ${sessionId}: agent prompt not detected after ${maxWaitMs / 1000}s, sending anyway`);
          }

          await runtime.sendMessage(handle, initialPrompt);
        } catch {
          // Non-fatal: agent is running but didn't receive the initial prompt.
          // User can retry with `co send`.
        }
      })();
    }

    return session;
  }

  async function list(projectId?: string): Promise<Session[]> {
    const allSessions = listAllSessions(projectId);

    const sessionPromises = allSessions.map(async ({ sessionName, projectId: sessionProjectId }) => {
      const project = config.projects[sessionProjectId];
      if (!project) return null;

      const sessionsDir = getProjectSessionsDir(project);
      const raw = readMetadataRaw(sessionsDir, sessionName);
      if (!raw) return null;

      // Get file timestamps for createdAt/lastActivityAt
      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, sessionName);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
      } catch {
        // If stat fails, timestamps will fall back to current time
      }

      const session = metadataToSession(sessionName, raw, createdAt, modifiedAt, sessionProjectId);

      const plugins = resolvePlugins(project, raw["agent"]);
      // Cap per-session enrichment at 2s
      const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      await Promise.race([ensureHandleAndEnrich(session, sessionName, project, plugins), enrichTimeout]);

      return session;
    });

    const results = await Promise.all(sessionPromises);
    return results.filter((s): s is Session => s !== null);
  }

  async function get(sessionId: SessionId): Promise<Session | null> {
    for (const project of Object.values(config.projects)) {
      const sessionsDir = getProjectSessionsDir(project);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;

      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, sessionId);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
      } catch {
        // Timestamps fall back to current time
      }

      const session = metadataToSession(sessionId, raw, createdAt, modifiedAt);

      const plugins = resolvePlugins(project, raw["agent"]);
      await ensureHandleAndEnrich(session, sessionId, project, plugins);

      return session;
    }

    return null;
  }

  async function kill(sessionId: SessionId): Promise<void> {
    let raw: Record<string, string> | null = null;
    let sessionsDir: string | null = null;
    let project: ProjectConfig | undefined;

    for (const proj of Object.values(config.projects)) {
      const dir = getProjectSessionsDir(proj);
      const metadata = readMetadataRaw(dir, sessionId);
      if (metadata) {
        raw = metadata;
        sessionsDir = dir;
        project = proj;
        break;
      }
    }

    if (!raw || !sessionsDir) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Destroy runtime
    if (raw["runtimeHandle"]) {
      const handle = safeJsonParse<RuntimeHandle>(raw["runtimeHandle"]);
      if (handle) {
        const runtimePlugin = registry.get<Runtime>(
          "runtime",
          handle.runtimeName ??
            (project ? (project.runtime ?? config.defaults.runtime) : config.defaults.runtime),
        );
        if (runtimePlugin) {
          try {
            await runtimePlugin.destroy(handle);
          } catch {
            // Runtime might already be gone
          }
        } else if (handle.id) {
          // Fallback: direct tmux kill when runtime plugin isn't loaded
          try {
            await execFileP("tmux", ["kill-session", "-t", handle.id], { timeout: 10_000 });
          } catch {
            // tmux session might already be gone
          }
        }
      }
    }

    // Destroy workspace -- skip if worktree is the project path
    const worktree = raw["worktree"];
    const isProjectPath = project && worktree === project.path;
    if (worktree && !isProjectPath) {
      const workspacePlugin = project
        ? resolvePlugins(project).workspace
        : registry.get<Workspace>("workspace", config.defaults.workspace);
      if (workspacePlugin) {
        try {
          await workspacePlugin.destroy(worktree);
        } catch {
          // Workspace might already be gone
        }
      } else {
        // Fallback: direct git worktree cleanup when plugin isn't loaded
        await directWorktreeCleanup(worktree, project, sessionId);
      }
    }

    // Archive metadata
    try {
      deleteMetadata(sessionsDir, sessionId, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      const missingMetadata = msg.includes("not found") || msg.includes("enoent") || msg.includes("no such file or directory");
      if (!missingMetadata) {
        throw err;
      }
    }
  }

  async function cleanup(
    projectId?: string,
    options?: { dryRun?: boolean },
  ): Promise<CleanupResult> {
    const result: CleanupResult = { killed: [], skipped: [], errors: [] };
    const sessions = await list(projectId);

    for (const session of sessions) {
      try {
        // Never clean up orchestrator sessions
        if (
          session.metadata["role"] === "orchestrator" ||
          session.id.endsWith("-orchestrator")
        ) {
          result.skipped.push(session.id);
          continue;
        }

        const project = config.projects[session.projectId];
        if (!project) {
          result.skipped.push(session.id);
          continue;
        }

        const plugins = resolvePlugins(project);
        let shouldKill = false;

        // Check if PR is merged
        if (session.pr && plugins.scm) {
          try {
            const prState = await plugins.scm.getPRState(session.pr);
            if (prState === PR_STATE.MERGED || prState === PR_STATE.CLOSED) {
              shouldKill = true;
            }
          } catch {
            // Can't check PR -- skip
          }
        }

        // Check if issue is completed
        if (!shouldKill && session.issueId && plugins.tracker) {
          try {
            const completed = await plugins.tracker.isCompleted(session.issueId, project);
            if (completed) shouldKill = true;
          } catch {
            // Can't check issue -- skip
          }
        }

        // Check if runtime is dead
        if (!shouldKill && session.runtimeHandle && plugins.runtime) {
          try {
            const alive = await plugins.runtime.isAlive(session.runtimeHandle);
            if (!alive) shouldKill = true;
          } catch {
            // Can't check -- skip
          }
        }

        if (shouldKill) {
          if (!options?.dryRun) {
            await kill(session.id);
          }
          result.killed.push(session.id);
        } else {
          result.skipped.push(session.id);
        }
      } catch (err) {
        result.errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  async function send(sessionId: SessionId, message: string): Promise<void> {
    let raw: Record<string, string> | null = null;
    for (const project of Object.values(config.projects)) {
      const sessionsDir = getProjectSessionsDir(project);
      const metadata = readMetadataRaw(sessionsDir, sessionId);
      if (metadata) {
        raw = metadata;
        break;
      }
    }

    if (!raw) throw new Error(`Session ${sessionId} not found`);

    let handle: RuntimeHandle;
    if (raw["runtimeHandle"]) {
      const parsed = safeJsonParse<RuntimeHandle>(raw["runtimeHandle"]);
      if (!parsed) {
        throw new Error(`Corrupted runtime handle for session ${sessionId}`);
      }
      handle = parsed;
    } else {
      handle = { id: sessionId, runtimeName: config.defaults.runtime, data: {} };
    }

    const project = config.projects[raw["project"] ?? ""];
    const runtimePlugin = registry.get<Runtime>(
      "runtime",
      handle.runtimeName ??
        (project ? (project.runtime ?? config.defaults.runtime) : config.defaults.runtime),
    );
    if (!runtimePlugin) {
      throw new Error(`No runtime plugin for session ${sessionId}`);
    }

    await runtimePlugin.sendMessage(handle, message);
  }

  async function retry(target: string, options?: RetryConfig): Promise<Session> {
    let source = await get(target);
    if (!source) {
      const sessions = await list();
      const byTask = sessions
        .filter((session) => session.metadata["taskId"] === target)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      source = byTask[0] ?? null;
    }

    if (!source) {
      throw new Error(`No session/task found for retry target: ${target}`);
    }

    const sourceLoc = findSessionLocation(source.id);
    if (!sourceLoc) {
      throw new Error(`Retry source session not found on disk: ${source.id}`);
    }

    const taskId = sourceLoc.raw["taskId"] ?? source.metadata["taskId"] ?? target;
    const newAttemptId = generateAttemptId();
    const prompt =
      sourceLoc.raw["prompt"]
      ?? source.metadata["prompt"]
      ?? source.issueId
      ?? source.metadata["summary"]
      ?? "";
    if (!prompt) {
      throw new Error(
        `Cannot retry ${source.id}: no prompt/issue context found in metadata`,
      );
    }

    const session = await spawn({
      projectId: source.projectId,
      issueId: source.issueId ?? undefined,
      prompt: source.issueId ? sourceLoc.raw["prompt"] ?? undefined : prompt,
      agent: options?.agent ?? sourceLoc.raw["agent"] ?? undefined,
      model: options?.model ?? sourceLoc.raw["model"] ?? undefined,
      baseBranch: options?.baseBranch ?? sourceLoc.raw["branch"] ?? source.branch ?? undefined,
      profile: options?.profile ?? sourceLoc.raw["profile"] ?? undefined,
      taskId,
      attemptId: newAttemptId,
      parentTaskId: sourceLoc.raw["parentTaskId"] ?? undefined,
      retryOfSessionId: source.id,
    });

    updateMetadata(sourceLoc.sessionsDir, source.id, {
      attemptStatus: "archived",
      supersededByAttemptId: newAttemptId,
    });

    return session;
  }

  async function taskGraph(taskId: string): Promise<TaskGraph | null> {
    const sessions = await list();
    const attempts = sessions
      .filter((session) => session.metadata["taskId"] === taskId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (attempts.length === 0) return null;

    const children = new Set<string>();
    for (const session of sessions) {
      if (session.metadata["parentTaskId"] !== taskId) continue;
      const childTaskId = session.metadata["taskId"];
      if (childTaskId) children.add(childTaskId);
    }

    const attemptSummaries: AttemptSummary[] = attempts.map((session) => ({
      attemptId: session.metadata["attemptId"] ?? `a-${session.id}`,
      sessionId: session.id,
      status: session.status,
      agent: session.metadata["agent"],
      model: session.metadata["model"],
      branch: session.branch,
      createdAt: session.createdAt,
    }));

    return {
      taskId,
      parentTaskId: attempts[0]?.metadata["parentTaskId"] ?? null,
      childrenTaskIds: [...children],
      attempts: attemptSummaries,
    };
  }

  async function submitFeedback(sessionId: SessionId, feedback: string): Promise<void> {
    const location = findSessionLocation(sessionId);
    if (!location) throw new Error(`Session ${sessionId} not found`);

    const instruction = [
      "Reviewer feedback received. Apply the requested changes and continue.",
      "",
      feedback.trim(),
    ].join("\n");
    await send(sessionId, instruction);
    updateMetadata(location.sessionsDir, sessionId, {
      status: "working",
      reviewDecision: "changes_requested",
    });
  }

  async function restore(sessionId: SessionId): Promise<Session> {
    // 1. Find session metadata across all projects (active first, then archive)
    let raw: Record<string, string> | null = null;
    let sessionsDir: string | null = null;
    let project: ProjectConfig | undefined;
    let projectId: string | undefined;
    let fromArchive = false;

    for (const [key, proj] of Object.entries(config.projects)) {
      const dir = getProjectSessionsDir(proj);
      const metadata = readMetadataRaw(dir, sessionId);
      if (metadata) {
        raw = metadata;
        sessionsDir = dir;
        project = proj;
        projectId = key;
        break;
      }
    }

    // Fall back to archived metadata
    if (!raw) {
      for (const [key, proj] of Object.entries(config.projects)) {
        const dir = getProjectSessionsDir(proj);
        const archived = readArchivedMetadataRaw(dir, sessionId);
        if (archived) {
          raw = archived;
          sessionsDir = dir;
          project = proj;
          projectId = key;
          fromArchive = true;
          break;
        }
      }
    }

    if (!raw || !sessionsDir || !project || !projectId) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // If restored from archive, recreate the active metadata file
    if (fromArchive) {
      writeMetadata(sessionsDir, sessionId, {
        worktree: raw["worktree"] ?? "",
        branch: raw["branch"] ?? "",
        status: raw["status"] ?? "killed",
        role: raw["role"],
        tmuxName: raw["tmuxName"],
        issue: raw["issue"],
        pr: raw["pr"],
        summary: raw["summary"],
        project: raw["project"],
        agent: raw["agent"],
        createdAt: raw["createdAt"],
        runtimeHandle: raw["runtimeHandle"],
        ciStatus: raw["ciStatus"],
        reviewDecision: raw["reviewDecision"],
        prState: raw["prState"],
        mergeReadiness: raw["mergeReadiness"],
        prTitle: raw["prTitle"],
        prHeadRef: raw["prHeadRef"],
        prBaseRef: raw["prBaseRef"],
        prDraft: raw["prDraft"],
        cost: raw["cost"],
        model: raw["model"],
        permissions: raw["permissions"] as "skip" | "default" | undefined,
        taskId: raw["taskId"],
        attemptId: raw["attemptId"],
        parentTaskId: raw["parentTaskId"],
        attemptStatus: raw["attemptStatus"],
        retryOfSessionId: raw["retryOfSessionId"],
        supersededByAttemptId: raw["supersededByAttemptId"],
        profile: raw["profile"],
        baseBranch: raw["baseBranch"],
        prompt: raw["prompt"],
        devServerLog: raw["devServerLog"],
      });
    }

    // 2. Reconstruct Session and enrich with live runtime state
    const session = metadataToSession(sessionId, raw);
    const plugins = resolvePlugins(project, raw["agent"]);
    await enrichSessionWithRuntimeState(session, plugins, true);

    // 3. Validate restorability
    if (!isRestorable(session)) {
      if (NON_RESTORABLE_STATUSES.has(session.status)) {
        throw new SessionNotRestorableError(sessionId, `status is "${session.status}"`);
      }
      throw new SessionNotRestorableError(sessionId, "session is not in a terminal state");
    }

    // 4. Validate required plugins
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${project.agent ?? config.defaults.agent}' not found`);
    }

    // 5. Check workspace
    const workspacePath = raw["worktree"] || project.path;
    const workspaceExists = plugins.workspace?.exists
      ? await plugins.workspace.exists(workspacePath)
      : existsSync(workspacePath);

    if (!workspaceExists) {
      if (!plugins.workspace?.restore) {
        throw new WorkspaceMissingError(workspacePath, "workspace plugin does not support restore");
      }
      if (!session.branch) {
        throw new WorkspaceMissingError(workspacePath, "branch metadata is missing");
      }
      try {
        const wsInfo = await plugins.workspace.restore(
          {
            projectId,
            project,
            sessionId,
            branch: session.branch,
          },
          workspacePath,
        );

        if (plugins.workspace.postCreate) {
          await plugins.workspace.postCreate(wsInfo, project);
        }
      } catch (err) {
        throw new WorkspaceMissingError(
          workspacePath,
          `restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 6. Destroy old runtime if still alive
    if (session.runtimeHandle) {
      try {
        await plugins.runtime.destroy(session.runtimeHandle);
      } catch {
        // Best effort -- may already be gone
      }
    }

    // 7. Get launch command -- try restore command first, fall back to fresh launch
    let launchCommand: string;
    const restoreMergedMcp = {
      ...config.defaults.mcpServers,
      ...project.mcpServers,
    };
    const restoreMcpServers =
      Object.keys(restoreMergedMcp).length > 0 ? restoreMergedMcp : undefined;

    const agentLaunchConfig = {
      sessionId,
      projectConfig: project,
      issueId: session.issueId ?? undefined,
      permissions: (raw["permissions"] as "skip" | "default" | undefined)
        ?? project.agentConfig?.permissions
        ?? "skip",
      model: raw["model"] ?? project.agentConfig?.model,
      mcpServers: restoreMcpServers,
      workspacePath,
    };

    // Set up workspace hooks (re-writes MCP config and shell wrappers on restore)
    if (plugins.agent.setupWorkspaceHooks) {
      await plugins.agent.setupWorkspaceHooks(workspacePath, {
        dataDir: sessionsDir,
        sessionId,
        mcpServers: restoreMcpServers,
      });
    }

    if (plugins.agent.getRestoreCommand) {
      const restoreCmd = await plugins.agent.getRestoreCommand(session, project);
      launchCommand = restoreCmd ?? plugins.agent.getLaunchCommand(agentLaunchConfig);
    } else {
      launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
    }

    const environment = plugins.agent.getEnvironment(agentLaunchConfig);

    // 8. Create runtime (reuse tmuxName from metadata)
    const tmuxName = raw["tmuxName"];
    const handle = await plugins.runtime.create({
      sessionId: tmuxName ?? sessionId,
      workspacePath,
      launchCommand,
      environment: {
        ...environment,
        CO_SESSION: sessionId,
        CO_DATA_DIR: sessionsDir,
        CO_SESSION_NAME: sessionId,
        ...(tmuxName && { CO_TMUX_NAME: tmuxName }),
      },
    });

    // 9. Update metadata
    const now = new Date().toISOString();
    updateMetadata(sessionsDir, sessionId, {
      status: "spawning",
      runtimeHandle: JSON.stringify(handle),
      restoredAt: now,
    });

    // 10. Run postLaunchSetup (non-fatal)
    const restoredSession: Session = {
      ...session,
      status: "spawning",
      activity: "active",
      workspacePath,
      runtimeHandle: handle,
      restoredAt: new Date(now),
    };

    if (plugins.agent.postLaunchSetup) {
      try {
        await plugins.agent.postLaunchSetup(restoredSession);
      } catch {
        // Non-fatal -- session is already running
      }
    }

    return restoredSession;
  }

  async function getOutput(sessionId: SessionId, lines = 500): Promise<string> {
    let raw: Record<string, string> | null = null;
    for (const project of Object.values(config.projects)) {
      const sessionsDir = getProjectSessionsDir(project);
      const metadata = readMetadataRaw(sessionsDir, sessionId);
      if (metadata) {
        raw = metadata;
        break;
      }
    }

    if (!raw) throw new Error(`Session ${sessionId} not found`);

    let handle: RuntimeHandle;
    if (raw["runtimeHandle"]) {
      const parsed = safeJsonParse<RuntimeHandle>(raw["runtimeHandle"]);
      if (!parsed) {
        throw new Error(`Corrupted runtime handle for session ${sessionId}`);
      }
      handle = parsed;
    } else {
      handle = { id: sessionId, runtimeName: config.defaults.runtime, data: {} };
    }

    const project = config.projects[raw["project"] ?? ""];
    const runtimePlugin = registry.get<Runtime>(
      "runtime",
      handle.runtimeName ??
        (project ? (project.runtime ?? config.defaults.runtime) : config.defaults.runtime),
    );
    if (!runtimePlugin) {
      throw new Error(`No runtime plugin for session ${sessionId}`);
    }

    return runtimePlugin.getOutput(handle, lines);
  }

  return {
    spawn,
    retry,
    taskGraph,
    submitFeedback,
    restore,
    list,
    get,
    kill,
    cleanup,
    send,
    getOutput,
  };
}
