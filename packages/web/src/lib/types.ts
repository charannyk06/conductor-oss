/**
 * Dashboard-specific types for the Conductor v2 web UI.
 *
 * Core types (SessionStatus, ActivityState, etc.) are re-exported from @conductor-oss/core.
 * Dashboard types flatten/extend core types for JSON-safe client-side rendering.
 */

// Inlined from @conductor-oss/core/types to avoid client-side bundle issues
// with serverExternalPackages excluding the core package from client builds.
// Using string to support all core + legacy + dashboard status values without conflicts
export type SessionStatus = string;
export type ActivityState =
  | "active" | "ready" | "idle" | "waiting_input" | "blocked" | "exited";
export type CIStatus = "pending" | "passing" | "failing" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";
export interface MergeReadiness {
  mergeable: boolean;
  ciPassing: boolean;
  approved: boolean;
  noConflicts: boolean;
  blockers: string[];
}
export type PRState = "open" | "merged" | "closed";

/**
 * Attention zone priority level, ordered by human action urgency:
 *
 * 1. merge   -- PR approved + CI green. One click to clear.
 * 2. respond -- Agent waiting for human input. Quick unblock.
 * 3. review  -- CI failed, changes requested. Needs investigation.
 * 4. pending -- Waiting on external (reviewer, CI). Nothing to do now.
 * 5. working -- Agents doing their thing. Don't interrupt.
 * 6. done    -- Merged or terminated. Archive.
 */
export type AttentionLevel =
  | "merge"
  | "respond"
  | "review"
  | "pending"
  | "working"
  | "done";

/** Flattened session for dashboard rendering. String dates for JSON safety. */
export interface DashboardSession {
  id: string;
  projectId: string;
  status: SessionStatus;
  activity: ActivityState | null;
  branch: string | null;
  issueId: string | null;
  summary: string | null;
  createdAt: string;
  lastActivityAt: string;
  pr: DashboardPR | null;
  metadata: Record<string, string>;
}

/** Flattened PR for dashboard rendering. */
export interface DashboardPR {
  number: number;
  url: string;
  title: string;
  branch: string;
  baseBranch: string;
  isDraft: boolean;
  state: PRState;
  ciStatus: CIStatus;
  reviewDecision: ReviewDecision;
  mergeability: MergeReadiness;
  previewUrl: string | null;
}

/** Aggregate stats for the dashboard status line. */
export interface DashboardStats {
  totalSessions: number;
  workingSessions: number;
  openPRs: number;
  needsAttention: number;
}

/** SSE snapshot event from /api/events */
export interface SSESnapshotEvent {
  type: "snapshot";
  sessions: Array<{
    id: string;
    status: SessionStatus;
    activity: ActivityState | null;
    attentionLevel: AttentionLevel;
    projectId: string;
    issueId: string | null;
    branch: string | null;
    createdAt: string;
    lastActivityAt: string;
    metadata: Record<string, string>;
    summary?: string | null;
    pr?: DashboardPR | null;
  }>;
}

/** Session statuses that indicate the session is no longer active. */
export const TERMINAL_STATUSES = new Set([
  "archived",
  "done",
  "killed",
  "errored",
  "terminated",
  "merged",
  "cleanup",
]);

/** Determines which attention zone a session belongs to. */
export function getAttentionLevel(session: DashboardSession): AttentionLevel {
  // Done: terminal states (matches TERMINAL_STATUSES)
  if (
    session.status === "merged" ||
    session.status === "archived" ||
    session.status === "killed" ||
    session.status === "errored" ||
    session.status === "cleanup" ||
    session.status === "done" ||
    session.status === "terminated"
  ) {
    return "done";
  }
  if (session.pr) {
    if (session.pr.state === "merged" || session.pr.state === "closed") {
      return "done";
    }
  }

  // Merge: PR is ready -- one click to clear
  if (session.status === "mergeable" || session.status === "approved") {
    return "merge";
  }
  if (session.pr?.mergeability.mergeable) {
    return "merge";
  }

  // Respond: agent is waiting for human input
  if (
    session.activity === "waiting_input" ||
    session.activity === "blocked"
  ) {
    return "respond";
  }
  if (
    session.status === "needs_input" ||
    session.status === "stuck"
  ) {
    return "respond";
  }
  // Exited agent with non-terminal status = crashed
  if (session.activity === "exited") {
    return "respond";
  }

  // Review: problems that need investigation
  if (session.status === "ci_failed" || session.status === "changes_requested") {
    return "review";
  }
  if (session.pr) {
    if (session.pr.ciStatus === "failing") return "review";
    if (session.pr.reviewDecision === "changes_requested") return "review";
    if (!session.pr.mergeability.noConflicts) return "review";
  }

  // Pending: waiting on external (reviewer, CI)
  if (session.status === "review_pending") {
    return "pending";
  }
  if (session.pr) {
    if (
      !session.pr.isDraft &&
      (session.pr.reviewDecision === "pending" || session.pr.reviewDecision === "none")
    ) {
      return "pending";
    }
  }

  // Working: agents doing their thing
  return "working";
}
