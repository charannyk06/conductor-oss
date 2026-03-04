// @ts-nocheck
/**
 * Core Session -> DashboardSession serialization.
 *
 * Converts core types (Date objects, PRInfo) into dashboard types
 * (string dates, flattened DashboardPR) suitable for JSON serialization.
 */

import type { Session, PRInfo } from "@conductor-oss/core/types";
import type { DashboardSession, DashboardPR, DashboardStats } from "./types";

export function normalizeSummary(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("You are an AI coding agent managed by Conductor")) return null;
  if (/^(Codex|Claude)\s+session\s*\(/i.test(cleaned)) return null;
  return cleaned;
}

function buildPRSummary(session: Session): string | null {
  if (!session.pr) return null;
  const meta = session.metadata;
  const title = session.pr.title || meta["prTitle"] || "";
  const state = meta["prState"] ?? "open";
  const ciStatus = meta["ciStatus"] ?? "none";
  const reviewDecision = meta["reviewDecision"] ?? "none";
  let text = `PR #${session.pr.number}${title ? ` — ${title}` : ""} · state: ${state} · CI: ${ciStatus} · review: ${reviewDecision}`;

  if (meta["mergeReadiness"]) {
    try {
      const readiness = JSON.parse(meta["mergeReadiness"]) as { blockers?: string[] };
      if (Array.isArray(readiness.blockers) && readiness.blockers.length > 0) {
        text += ` · blockers: ${readiness.blockers.join("; ")}`;
      }
    } catch {
      // ignore malformed mergeReadiness
    }
  }
  return text;
}

/** Convert a core Session to a DashboardSession. */
export function sessionToDashboard(session: Session): DashboardSession {
  const summary =
    normalizeSummary(session.agentInfo?.summary ?? session.metadata["summary"] ?? null)
    ?? buildPRSummary(session)
    ?? null;

  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    summary,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr: session.pr ? prToDashboard(session.pr, session.metadata) : null,
    metadata: session.metadata,
  };
}

/** Convert a core PRInfo to a DashboardPR, reading persisted data from metadata. */
function prToDashboard(pr: PRInfo, metadata: Record<string, string>): DashboardPR {
  // Parse merge readiness from JSON-serialized metadata
  let mergeability: DashboardPR["mergeability"] = {
    mergeable: false,
    ciPassing: false,
    approved: false,
    noConflicts: true,
    blockers: [],
  };
  if (metadata["mergeReadiness"]) {
    try {
      const parsed = JSON.parse(metadata["mergeReadiness"]) as Record<string, unknown>;
      mergeability = {
        mergeable: Boolean(parsed["mergeable"]),
        ciPassing: Boolean(parsed["ciPassing"]),
        approved: Boolean(parsed["approved"]),
        noConflicts: parsed["noConflicts"] !== false,
        blockers: Array.isArray(parsed["blockers"])
          ? (parsed["blockers"] as string[])
          : [],
      };
    } catch {
      // Invalid JSON — use defaults
    }
  }

  const title = pr.title || metadata["prTitle"] || "";
  const branch = pr.branch || metadata["prHeadRef"] || "";
  const baseBranch = pr.baseBranch || metadata["prBaseRef"] || "";
  const isDraft =
    pr.isDraft || metadata["prDraft"] === "1" || metadata["prDraft"] === "true";

  return {
    number: pr.number,
    url: pr.url,
    title,
    branch,
    baseBranch,
    isDraft,
    state: (metadata["prState"] as DashboardPR["state"]) || "open",
    ciStatus: (metadata["ciStatus"] as DashboardPR["ciStatus"]) || "none",
    reviewDecision: (metadata["reviewDecision"] as DashboardPR["reviewDecision"]) || "none",
    mergeability,
    previewUrl: metadata["previewUrl"] ?? null,
  };
}

/** Compute aggregate stats from dashboard sessions. */
export function computeStats(sessions: DashboardSession[]): DashboardStats {
  return {
    totalSessions: sessions.length,
    workingSessions: sessions.filter((s) => s.activity === "active").length,
    openPRs: sessions.filter((s) => s.pr?.state === "open").length,
    needsAttention: sessions.filter(
      (s) =>
        s.status === "needs_input" ||
        s.status === "stuck" ||
        s.status === "errored" ||
        s.activity === "waiting_input" ||
        s.activity === "blocked"
    ).length,
  };
}
