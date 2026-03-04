/**
 * Lifecycle Manager -- polls sessions and advances their state machine.
 *
 * On each tick (default 30s):
 *   1. List all sessions across all projects
 *   2. For each non-terminal session:
 *      a. Detect PR if not yet tracked
 *      b. Check CI status, review status, merge readiness
 *      c. Update session status accordingly
 *      d. Trigger reactions (send-to-agent, notify) based on state transitions
 *      e. Emit events to notifiers
 *   3. Detect stuck/exited/needs_input sessions
 *   4. Fire "all_complete" when every session in a project finishes
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  LifecycleManager,
  SessionManager,
  Session,
  SessionId,
  SessionStatus,
  OrchestratorConfig,
  ProjectConfig,
  Notifier,
  SCM,
  Runtime,
  PluginRegistry,
  OrchestratorEvent,
  EventType,
  EventPriority,
  ReactionConfig,
  PRInfo,
  CIStatus,
  ReviewDecision,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const DEFAULT_POLL_MS = 30_000;

/** Session statuses that should not be polled. */
const SKIP_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "killed", "terminated", "done", "cleanup", "merged", "errored",
]);

/** Parse an escalation threshold like "15m", "30m", "2" (count). */
function parseEscalation(value: number | string | undefined): {
  type: "count" | "duration";
  value: number;
} | null {
  if (value === undefined) return null;
  if (typeof value === "number") return { type: "count", value };
  const match = String(value).match(/^(\d+)(m|min|s|sec|h|hr)?$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (!unit) return { type: "count", value: num };
  const multiplier = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000;
  return { type: "duration", value: num * multiplier };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  registry?: PluginRegistry;
  /** Called whenever a session's status changes — triggers immediate board sync. */
  onStatusChange?: (sessionId: string, newStatus: SessionStatus, projectId: string) => void;
}

interface SessionState {
  lastStatus: SessionStatus;
  prDetected: boolean;
  lastCIStatus: CIStatus | null;
  lastReviewDecision: ReviewDecision | null;
  reactionCounts: Record<string, number>;
  reactionFirstSeen: Record<string, number>;
  lastCheckedAt: number;
}


async function fetchGitHubPRDetails(pr: PRInfo): Promise<Partial<PRInfo> | null> {
  if (!pr.owner || !pr.repo || !pr.number) return null;
  try {
    const { stdout } = await execFileAsync("gh", [
      "pr",
      "view",
      String(pr.number),
      "--repo",
      `${pr.owner}/${pr.repo}`,
      "--json",
      "title,headRefName,baseRefName,isDraft,url,state,mergeStateStatus",
    ], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });

    const data = JSON.parse(stdout) as {
      title?: string;
      headRefName?: string;
      baseRefName?: string;
      isDraft?: boolean;
      url?: string;
      state?: string;
      mergeStateStatus?: string;
    };

    const partial: Partial<PRInfo> & { state?: string; mergeStateStatus?: string } = {
      title: data.title ?? pr.title,
      branch: data.headRefName ?? pr.branch,
      baseBranch: data.baseRefName ?? pr.baseBranch,
      isDraft: data.isDraft ?? pr.isDraft,
      url: data.url ?? pr.url,
    };
    if (data.state) partial.state = data.state;
    if (data.mergeStateStatus) partial.mergeStateStatus = data.mergeStateStatus;

    return partial;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, sessionManager, registry } = deps;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let ticking = false;

  /** Per-session tracking state. */
  const states = new Map<SessionId, SessionState>();

  /** Track which projects have already fired all_complete (prevent repeat). */
  const allCompleteFired = new Set<string>();

  /** Get or create tracking state for a session. */
  function getState(session: Session): SessionState {
    let state = states.get(session.id);
    if (!state) {
      state = {
        lastStatus: session.status,
        prDetected: session.pr !== null,
        lastCIStatus: null,
        lastReviewDecision: null,
        reactionCounts: {},
        reactionFirstSeen: {},
        lastCheckedAt: Date.now(),
      };
      states.set(session.id, state);
    }
    return state;
  }

  /** Resolve notifiers for a given priority. */
  function getNotifiers(priority: EventPriority): Notifier[] {
    if (!registry) return [];
    const names = config.notificationRouting[priority] ?? config.defaults.notifiers;
    const result: Notifier[] = [];
    for (const name of names) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) result.push(notifier);
    }
    return result;
  }

  /** Get SCM plugin for a project. */
  function getSCM(project: ProjectConfig): SCM | null {
    if (!registry || !project.scm) return null;
    return registry.get<SCM>("scm", project.scm.plugin);
  }

  function getRuntime(project: ProjectConfig): Runtime | null {
    if (!registry) return null;
    return registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
  }

  async function isRuntimeAlive(session: Session, project: ProjectConfig): Promise<boolean> {
    const runtime = getRuntime(project);
    if (!runtime || !session.runtimeHandle) return false;
    try {
      return await runtime.isAlive(session.runtimeHandle);
    } catch {
      return false;
    }
  }

  async function hydratePRInfo(
    session: Session,
    project: ProjectConfig,
    scm: SCM,
  ): Promise<void> {
    if (!session.pr) return;

    let hydrated: PRInfo | null = null;

    // First choice: detect via branch in project repo (fast path).
    if (session.branch) {
      try {
        const detected = await scm.detectPR(session, project);
        if (detected) hydrated = detected;
      } catch {
        // ignore
      }
    }

    // Fallback: hydrate from the known PR URL/repo.
    if (!hydrated) {
      const details = await fetchGitHubPRDetails(session.pr);
      if (details) {
        hydrated = {
          ...session.pr,
          ...details,
          title: details.title ?? session.pr.title,
          branch: details.branch ?? session.pr.branch,
          baseBranch: details.baseBranch ?? session.pr.baseBranch,
          isDraft: details.isDraft ?? session.pr.isDraft,
          url: details.url ?? session.pr.url,
        };
      }
    }

    if (!hydrated) return;

    session.pr = hydrated;
    const hydrateFields: Record<string, string> = {
      pr: hydrated.url,
      prTitle: hydrated.title ?? "",
      prHeadRef: hydrated.branch ?? "",
      prBaseRef: hydrated.baseBranch ?? "",
      prDraft: hydrated.isDraft ? "1" : "0",
    };

    // Persist state and mergeStateStatus if available from fetchGitHubPRDetails
    const detailsWithExtra = hydrated as PRInfo & { state?: string; mergeStateStatus?: string };
    if (detailsWithExtra.state) hydrateFields["prState"] = detailsWithExtra.state.toLowerCase();
    if (detailsWithExtra.mergeStateStatus) hydrateFields["mergeStateStatus"] = detailsWithExtra.mergeStateStatus;

    updateSessionFields(session, hydrateFields);
  }

  /** Emit an event to all relevant notifiers. */
  async function emit(event: OrchestratorEvent): Promise<void> {
    const notifiers = getNotifiers(event.priority);
    await Promise.allSettled(notifiers.map((n) => n.notify(event)));
  }

  /** Create an event object. */
  function createEvent(
    type: EventType,
    priority: EventPriority,
    session: Session,
    message: string,
    data: Record<string, unknown> = {},
  ): OrchestratorEvent {
    return {
      id: randomUUID(),
      type,
      priority,
      sessionId: session.id,
      projectId: session.projectId,
      timestamp: new Date(),
      message,
      data,
    };
  }

  /** Update session status in metadata. */
  function updateSessionStatus(session: Session, newStatus: SessionStatus): void {
    const project = config.projects[session.projectId];
    if (!project) return;
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, { status: newStatus });
    // Trigger immediate board sync on status change
    deps.onStatusChange?.(session.id, newStatus, session.projectId);
  }

  /** Update PR URL in metadata. */
  function updateSessionPR(session: Session, pr: PRInfo): void {
    const project = config.projects[session.projectId];
    if (!project) return;
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, { pr: pr.url });
  }

  /** Persist arbitrary fields to session metadata. */
  function updateSessionFields(session: Session, fields: Record<string, string>): void {
    const project = config.projects[session.projectId];
    if (!project) return;
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, fields);
  }

  /** Process a reaction config. */
  async function processReaction(
    reactionName: string,
    reaction: ReactionConfig,
    session: Session,
    state: SessionState,
  ): Promise<void> {
    if (!reaction.auto) return;

    const count = (state.reactionCounts[reactionName] ?? 0) + 1;
    state.reactionCounts[reactionName] = count;

    if (!state.reactionFirstSeen[reactionName]) {
      state.reactionFirstSeen[reactionName] = Date.now();
    }

    // Check if we should escalate
    const escalation = parseEscalation(reaction.escalateAfter);
    let shouldEscalate = false;

    if (escalation) {
      if (escalation.type === "count" && count > escalation.value) {
        shouldEscalate = true;
      } else if (escalation.type === "duration") {
        const elapsed = Date.now() - state.reactionFirstSeen[reactionName];
        if (elapsed > escalation.value) {
          shouldEscalate = true;
        }
      }
    }

    // Check retries limit
    if (reaction.retries !== undefined && count > reaction.retries && !shouldEscalate) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      await emit(
        createEvent(
          "reaction.escalated",
          "urgent",
          session,
          `Reaction "${reactionName}" escalated after ${count} attempts on ${session.id}`,
          { reactionName, attempts: count },
        ),
      );
      return;
    }

    if (reaction.action === "send-to-agent" && reaction.message) {
      try {
        await sessionManager.send(session.id, reaction.message);
        await emit(
          createEvent(
            "reaction.triggered",
            "info",
            session,
            `Sent "${reactionName}" fix to ${session.id}`,
            { reactionName, action: "send-to-agent" },
          ),
        );
      } catch {
        // Can't send -- session may be dead
      }
    } else if (reaction.action === "notify") {
      await emit(
        createEvent(
          "reaction.triggered",
          reaction.priority ?? "info",
          session,
          reaction.message ?? `Reaction "${reactionName}" triggered on ${session.id}`,
          { reactionName, action: "notify" },
        ),
      );
    }
  }

  /** Merge project-level reaction overrides with global reactions. */
  function getReactions(project: ProjectConfig): Record<string, ReactionConfig> {
    const merged = { ...config.reactions };
    if (project.reactions) {
      for (const [key, override] of Object.entries(project.reactions)) {
        if (merged[key]) {
          merged[key] = { ...merged[key], ...override } as ReactionConfig;
        }
      }
    }
    return merged;
  }

  /** Check a single session and advance its state. */
  async function checkSession(session: Session): Promise<void> {
    if (SKIP_STATUSES.has(session.status)) return;

    const project = config.projects[session.projectId];
    if (!project) return;

    const state = getState(session);
    const scm = getSCM(project);
    const reactions = getReactions(project);
    const previousStatus = state.lastStatus;

    // ------- Activity-based detection -------

    // Grace period: don't mark sessions as exited during the first 120s
    // (agent process may not have started yet — shell init, worktree setup, etc.)
    const createdMs = session.createdAt instanceof Date ? session.createdAt.getTime() : typeof session.createdAt === "number" ? session.createdAt : Date.now();
    const ageMs = Date.now() - createdMs;
    const rtCreated = Number(session.runtimeHandle?.data?.["createdAt"] ?? Date.now());
    const runtimeAge = Date.now() - rtCreated;
    const effectiveAge = Math.max(ageMs, runtimeAge);
    if (session.activity === "exited" && session.status === "spawning" && effectiveAge < 120_000) {
      return; // Still in spawn grace period — skip
    }

    // Max spawn timeout: if a session has been "spawning" for over 10 minutes
    // without transitioning to "working", it's a zombie — auto-terminate it.
    const SPAWN_TIMEOUT_MS = 600_000; // 10 minutes
    if (session.status === "spawning" && effectiveAge > SPAWN_TIMEOUT_MS) {
      console.log(`[lifecycle] ${session.id}: spawn timeout (${Math.round(effectiveAge / 60_000)}m) — terminating zombie session`);
      updateSessionStatus(session, "killed");
      state.lastStatus = "killed";
      await emit(createEvent("session.exited", "urgent", session, `Session ${session.id} killed — spawn timeout after ${Math.round(effectiveAge / 60_000)}m`));
      const rt = getRuntime(project);
      if (session.runtimeHandle && rt) {
        try { await rt.destroy(session.runtimeHandle); } catch { /* best-effort */ }
      }
      return;
    }

    // Detect exited sessions — agent process is no longer running.
    // If the session was actively working (not just spawning), treat as
    // normal completion ("done") rather than a crash ("killed").
    // Attempt PR detection first so we don't lose PRs created on the final action.
    if (session.activity === "exited" && !SKIP_STATUSES.has(session.status)) {
      const wasWorking = previousStatus !== "spawning";

      // Attempt PR detection before deciding terminal status
      if (wasWorking && !session.pr && scm && session.branch) {
        try {
          const pr = await scm.detectPR(session, project);
          if (pr) {
            session.pr = pr;
            state.prDetected = true;
            updateSessionPR(session, pr);
          }
        } catch {
          // PR detection failed — continue without PR
        }
      }

      const newStatus: SessionStatus = wasWorking
        ? (session.pr ? "pr_open" : "done")
        : "killed";
      updateSessionStatus(session, newStatus);
      state.lastStatus = newStatus;
      if (wasWorking) {
        console.log(`[lifecycle] ${session.id}: exited after working → ${newStatus}`);
        await emit(createEvent("session.exited", "info", session, `Session ${session.id} completed (exited → ${newStatus})`));
      } else {
        await emit(createEvent("session.exited", "urgent", session, `Session ${session.id} exited`));
        if (reactions["agent-exited"]) {
          await processReaction("agent-exited", reactions["agent-exited"], session, state);
        }
      }
      return;
    }

    // Detect needs_input
    if (session.activity === "waiting_input" && previousStatus !== "needs_input") {
      updateSessionStatus(session, "needs_input");
      state.lastStatus = "needs_input";
      await emit(
        createEvent(
          "session.needs_input",
          "urgent",
          session,
          `Session ${session.id} is waiting for input`,
        ),
      );
      if (reactions["agent-needs-input"]) {
        await processReaction("agent-needs-input", reactions["agent-needs-input"], session, state);
      }
      return;
    }

    // Detect agent finished — only "ready" means the agent truly completed
    // (summary emitted). "idle" just means no recent JSONL activity, which
    // could be the agent thinking or waiting. Don't mark idle as done.
    // PR-tracked sessions are handled by the PR lifecycle below.
    if (
      session.activity === "ready" &&
      !session.pr &&
      !SKIP_STATUSES.has(previousStatus) &&
      previousStatus !== "spawning"
    ) {
      const isAlive = await isRuntimeAlive(session, project);
      if (isAlive) return;

      // Attempt PR detection before deciding terminal status —
      // the agent may have created a PR on its final action.
      if (scm && session.branch) {
        try {
          const pr = await scm.detectPR(session, project);
          if (pr) {
            session.pr = pr;
            state.prDetected = true;
            updateSessionPR(session, pr);
          }
        } catch {
          // PR detection failed — continue without PR
        }
      }

      const newStatus: SessionStatus = session.pr ? "pr_open" : "done";
      console.log(
        `[lifecycle] ${session.id}: activity=ready, prev=${previousStatus} → ${newStatus}`,
      );
      updateSessionStatus(session, newStatus);
      state.lastStatus = newStatus;
      await emit(
        createEvent(
          "session.exited",
          "info",
          session,
          `Session ${session.id} completed (was: ${previousStatus} → ${newStatus})`,
        ),
      );
      if (session.pr) {
        await emit(
          createEvent("pr.created", "info", session, `PR #${session.pr.number} opened: ${session.pr.title}`, {
            url: session.pr.url,
            branch: session.pr.branch,
          }),
        );
      }
      return;
    }

    // Detect stuck sessions — only when already working/in-progress,
    // Auto-complete: if agent created a PR and is now idle/exited 2+ minutes — it finished.
    if (session.pr && (session.activity === "idle" || session.activity === "exited")) {
      const idleTime = Date.now() - session.lastActivityAt.getTime();
      if (idleTime > 120_000 && session.status === "pr_open") {
        console.log(`[lifecycle] Session ${session.id} idle after PR — marking done`);
        updateSessionStatus(session, "done");
        state.lastStatus = "done";
        return;
      }
    }

    // not when agent just finished and is idle at prompt.
    if (session.activity === "blocked") {
      const threshold = reactions["agent-stuck"]?.threshold;
      const thresholdMs = threshold ? parseEscalation(threshold)?.value ?? 600_000 : 600_000;
      const idleTime = Date.now() - session.lastActivityAt.getTime();

      if (idleTime > thresholdMs && previousStatus !== "stuck") {
        updateSessionStatus(session, "stuck");
        state.lastStatus = "stuck";
        await emit(
          createEvent(
            "session.stuck",
            "urgent",
            session,
            `Session ${session.id} appears stuck (idle ${Math.round(idleTime / 60_000)}m)`,
          ),
        );
        if (reactions["agent-stuck"]) {
          await processReaction("agent-stuck", reactions["agent-stuck"], session, state);
        }
        return;
      }
    }

    // ------- PR detection -------

    if (!session.pr && scm && session.branch) {
      try {
        const pr = await scm.detectPR(session, project);
        if (pr) {
          session.pr = pr;
          state.prDetected = true;
          updateSessionPR(session, pr);
          updateSessionStatus(session, "pr_open");
          state.lastStatus = "pr_open";
          await emit(
            createEvent("pr.created", "info", session, `PR #${pr.number} opened: ${pr.title}`, {
              url: pr.url,
              branch: pr.branch,
            }),
          );
        }
      } catch (err) {
        console.warn(`[lifecycle] PR detection failed for ${session.id}: ${(err as Error).message}`);
      }
    }

    // ------- PR lifecycle (CI, reviews, merge) -------

    if (session.pr && scm) {
      // If PR metadata was created by shell hooks, title/base branch may be blank.
      if (!session.pr.title || !session.pr.baseBranch || !session.pr.branch) {
        await hydratePRInfo(session, project, scm);
      }

      // Detect deployment preview URL
      if (scm.getDeploymentPreviewUrl) {
        try {
          const previewUrl = await scm.getDeploymentPreviewUrl(session.pr);
          if (previewUrl) {
            updateSessionFields(session, { previewUrl });
          }
        } catch {
          // Preview URL detection is best-effort
        }
      }

      const pr = session.pr;

      // Check PR state -- may have been merged/closed externally
      try {
        const prState = await scm.getPRState(pr);
        updateSessionFields(session, { prState });
        if (prState === "merged") {
          updateSessionStatus(session, "merged");
          state.lastStatus = "merged";
          await emit(
            createEvent("pr.merged", "info", session, `PR #${pr.number} merged`, {
              url: pr.url,
            }),
          );
          return;
        }
        if (prState === "closed") {
          updateSessionStatus(session, "done");
          state.lastStatus = "done";
          await emit(
            createEvent("pr.closed", "info", session, `PR #${pr.number} closed`, {
              url: pr.url,
            }),
          );
          return;
        }
      } catch (err) {
        console.warn(`[lifecycle] PR state check failed for ${session.id}: ${(err as Error).message}`);
      }

      // Check CI
      try {
        const ciStatus = await scm.getCISummary(pr);
        const prevCI = state.lastCIStatus;
        state.lastCIStatus = ciStatus;
        updateSessionFields(session, { ciStatus });

        if (ciStatus === "failing" && prevCI !== "failing") {
          updateSessionStatus(session, "ci_failed");
          state.lastStatus = "ci_failed";
          await emit(
            createEvent("ci.failing", "warning", session, `CI failing on PR #${pr.number}`, {
              url: pr.url,
            }),
          );
          if (reactions["ci-failed"]) {
            await processReaction("ci-failed", reactions["ci-failed"], session, state);
          }
        } else if (ciStatus === "passing" && prevCI === "failing") {
          // CI recovered — reset status back to pr_open so review/merge checks
          // can re-determine the correct status on this same tick.
          if (session.status === "ci_failed") {
            updateSessionStatus(session, "pr_open");
            state.lastStatus = "pr_open";
          }
          await emit(
            createEvent("ci.passing", "info", session, `CI passing on PR #${pr.number}`, {
              url: pr.url,
            }),
          );
          // Clear CI reaction counters on recovery
          delete state.reactionCounts["ci-failed"];
          delete state.reactionFirstSeen["ci-failed"];
        }
      } catch (err) {
        console.warn(`[lifecycle] CI check failed for ${session.id}: ${(err as Error).message}`);
      }

      // Check reviews
      try {
        const reviewDecision = await scm.getReviewDecision(pr);
        const prevReview = state.lastReviewDecision;
        state.lastReviewDecision = reviewDecision;
        updateSessionFields(session, { reviewDecision });

        if (reviewDecision === "changes_requested" && prevReview !== "changes_requested") {
          updateSessionStatus(session, "changes_requested");
          state.lastStatus = "changes_requested";
          await emit(
            createEvent(
              "review.changes_requested",
              "action",
              session,
              `Changes requested on PR #${pr.number}`,
              { url: pr.url },
            ),
          );
          if (reactions["changes-requested"]) {
            await processReaction("changes-requested", reactions["changes-requested"], session, state);
          }
        } else if (reviewDecision === "approved" && prevReview !== "approved") {
          updateSessionStatus(session, "approved");
          state.lastStatus = "approved";
          await emit(
            createEvent(
              "review.approved",
              "info",
              session,
              `PR #${pr.number} approved`,
              { url: pr.url },
            ),
          );
        }
      } catch (err) {
        console.warn(`[lifecycle] Review check failed for ${session.id}: ${(err as Error).message}`);
      }

      // Check merge readiness
      try {
        const readiness = await scm.getMergeability(pr);
        updateSessionFields(session, { mergeReadiness: JSON.stringify(readiness) });

        if (readiness.mergeable) {
          if (state.lastStatus !== "mergeable") {
            updateSessionStatus(session, "mergeable");
            state.lastStatus = "mergeable";
            await emit(
              createEvent(
                "merge.ready",
                "action",
                session,
                `PR #${pr.number} is ready to merge`,
                { url: pr.url, blockers: [] },
              ),
            );
            // Notify via approved-and-green reaction (NEVER auto-merge)
            if (reactions["approved-and-green"]) {
              await processReaction(
                "approved-and-green",
                reactions["approved-and-green"],
                session,
                state,
              );
            }
          }
        } else if (!readiness.noConflicts) {
          if (reactions["merge-conflicts"]) {
            await processReaction("merge-conflicts", reactions["merge-conflicts"], session, state);
          }
          await emit(
            createEvent(
              "merge.conflicts",
              "warning",
              session,
              `PR #${pr.number} has merge conflicts`,
              { url: pr.url, blockers: readiness.blockers },
            ),
          );
        }
      } catch (err) {
        console.warn(`[lifecycle] Merge check failed for ${session.id}: ${(err as Error).message}`);
      }
    }

    // Persist summary and cost from agent info (if available)
    if (session.agentInfo) {
      const fields: Record<string, string> = {};
      if (session.agentInfo.summary) {
        fields["summary"] = session.agentInfo.summary;
      }
      if (session.agentInfo.cost) {
        fields["cost"] = JSON.stringify(session.agentInfo.cost);
      }
      if (Object.keys(fields).length > 0) {
        updateSessionFields(session, fields);
      }
    }

    // Update tracking state
    state.lastCheckedAt = Date.now();

    // Track status transitions for working state
    if (previousStatus === "spawning") {
      if (session.activity === "active") {
        // Agent is actively working — advance to "working"
        updateSessionStatus(session, "working");
        state.lastStatus = "working";
        await emit(
          createEvent("session.working", "info", session, `Session ${session.id} is working`),
        );
      } else if (session.activity === "ready") {
        const isAlive = await isRuntimeAlive(session, project);
        if (isAlive) {
          updateSessionStatus(session, "working");
          state.lastStatus = "working";
          await emit(
            createEvent("session.working", "info", session, `Session ${session.id} is working`),
          );
          return;
        }

        // Avoid misclassifying sessions as complete during initial prompt/setup.
        // Some agents emit a ready/idle prompt immediately after spawn.
        if (effectiveAge < 120_000) {
          return;
        }

        // Agent went from spawning straight to ready (summary emitted) — lifecycle
        // missed the active window entirely (e.g. daemon wasn't running). The session
        // clearly worked and completed. Attempt PR detection before deciding status.
        if (!session.pr && scm && session.branch) {
          try {
            const pr = await scm.detectPR(session, project);
            if (pr) {
              session.pr = pr;
              state.prDetected = true;
              updateSessionPR(session, pr);
            }
          } catch {
            // PR detection failed — continue without PR
          }
        }
        const newStatus: SessionStatus = session.pr ? "pr_open" : "done";
        console.log(
          `[lifecycle] ${session.id}: spawning → ${session.activity} (missed active window) → ${newStatus}`,
        );
        updateSessionStatus(session, newStatus);
        state.lastStatus = newStatus;
        await emit(
          createEvent(
            "session.exited",
            "info",
            session,
            `Session ${session.id} completed (spawning → ${newStatus})`,
          ),
        );
      }
    }

    // ------- Stale session watchdog (safety net) -------
    // If agent-specific detection fails completely (returns null → activity
    // stays null) or returns "idle" but the session never transitions,
    // force-complete after an extended period. This is the last-resort
    // catch-all so sessions never stay stuck forever.
    const WATCHDOG_THRESHOLD_MS = 30 * 60_000; // 30 minutes
    if (
      !SKIP_STATUSES.has(session.status) &&
      session.status !== "spawning" &&
      !session.pr &&
      (session.activity === "idle" || session.activity === null)
    ) {
      const idleMs = Date.now() - session.lastActivityAt.getTime();
      if (idleMs > WATCHDOG_THRESHOLD_MS) {
        console.log(
          `[lifecycle] ${session.id}: stale watchdog → done ` +
          `(status=${session.status}, activity=${String(session.activity)}, idle=${Math.round(idleMs / 60_000)}m)`,
        );
        updateSessionStatus(session, "done");
        state.lastStatus = "done";
        await emit(
          createEvent(
            "session.exited",
            "warning",
            session,
            `Session ${session.id} force-completed by watchdog (idle ${Math.round(idleMs / 60_000)}m)`,
            { reason: "stale_watchdog" },
          ),
        );
      }
    }
  }

  /** Run a full poll cycle across all sessions. */
  async function tick(): Promise<void> {
    if (!running || ticking) return;
    ticking = true;

    try {
      const sessions = await sessionManager.list();
      const activeSessions = sessions.filter((s) => !SKIP_STATUSES.has(s.status));
      if (activeSessions.length > 0) {
        console.log(
          `[lifecycle] Tick: ${activeSessions.length} active session(s): ${activeSessions.map((s) => `${s.id}[${s.status}/${s.activity ?? "?"}]`).join(", ")}`,
        );
      }

      // Check each session (with concurrency limit)
      const CONCURRENCY = 3;
      for (let i = 0; i < sessions.length; i += CONCURRENCY) {
        const batch = sessions.slice(i, i + CONCURRENCY);
        await Promise.allSettled(batch.map((s) => checkSession(s)));
      }

      // Check for all-complete per project
      const projectSessions = new Map<string, Session[]>();
      for (const session of sessions) {
        const list = projectSessions.get(session.projectId) ?? [];
        list.push(session);
        projectSessions.set(session.projectId, list);
      }

      for (const [projectId, projSessions] of projectSessions) {
        const allDone = projSessions.every((s) => SKIP_STATUSES.has(s.status));
        if (allDone && projSessions.length > 0) {
          // Only fire all_complete once per project (reset when new sessions appear)
          if (allCompleteFired.has(projectId)) continue;
          allCompleteFired.add(projectId);

          const project = config.projects[projectId];
          if (project) {
            const reactions = getReactions(project);
            if (reactions["all-complete"]) {
              const summarySession = projSessions[0];
              await emit(
                createEvent(
                  "summary.all_complete",
                  "info",
                  summarySession,
                  `All ${projSessions.length} sessions complete for ${projectId}`,
                  {
                    sessionCount: projSessions.length,
                    statuses: projSessions.map((s) => ({ id: s.id, status: s.status })),
                  },
                ),
              );
            }
          }
        } else if (!allDone) {
          // Reset when a project has non-terminal sessions again
          allCompleteFired.delete(projectId);
        }
      }

      // Clean up tracking state for sessions that no longer exist
      const activeIds = new Set(sessions.map((s) => s.id));
      for (const id of states.keys()) {
        if (!activeIds.has(id)) {
          states.delete(id);
        }
      }
    } catch (err) {
      console.error(`[lifecycle] Tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ticking = false;
    }
  }

  return {
    start(intervalMs?: number): void {
      if (running) return;
      running = true;
      const ms = intervalMs ?? DEFAULT_POLL_MS;
      console.log(`[lifecycle] Starting poll loop (every ${ms / 1000}s)`);
      // Run first tick immediately, then on interval
      void tick();
      intervalHandle = setInterval(() => void tick(), ms);
    },

    stop(): void {
      running = false;
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      console.log("[lifecycle] Stopped");
    },

    getStates(): Map<SessionId, SessionStatus> {
      const result = new Map<SessionId, SessionStatus>();
      for (const [id, state] of states) {
        result.set(id, state.lastStatus);
      }
      return result;
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (session) {
        await checkSession(session);
      }
    },
  };
}
