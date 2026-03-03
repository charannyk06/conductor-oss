import { type NextRequest, NextResponse } from "next/server";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";
import { sessionToDashboard, normalizeSummary } from "@/lib/serialize";
import type { DashboardSession } from "@/lib/types";

const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

/** Parse key=value metadata file. */
function parseMetadata(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return result;
}

function readMetadataFile(filePath: string): Record<string, string> | null {
  try {
    return parseMetadata(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function safeSessionDirs(projectDir: string): string[] {
  try {
    return readdirSync(projectDir);
  } catch {
    return [];
  }
}

function buildArchivedSummary(meta: Record<string, string>): string | null {
  const existing = normalizeSummary(meta["summary"]);
  if (existing) return existing;
  if (!meta["pr"]) return null;

  const prNumber = parseInt(meta["pr"].match(/\/(\d+)$/)?.[1] ?? "0", 10);
  const prTitle = meta["prTitle"] ?? "";
  const prState = meta["prState"] ?? "open";
  const ciStatus = meta["ciStatus"] ?? "none";
  const reviewDecision = meta["reviewDecision"] ?? "none";
  return `PR #${Number.isFinite(prNumber) && prNumber > 0 ? prNumber : "?"}${prTitle ? ` — ${prTitle}` : ""} · state: ${prState} · CI: ${ciStatus} · review: ${reviewDecision}`;
}

function parsePRFromMeta(meta: Record<string, string>): DashboardSession["pr"] {
  const prUrl = meta["pr"];
  if (!prUrl) return null;

  const num = parseInt(prUrl.match(/\/(\d+)$/)?.[1] ?? "0", 10);
  let mergeability: NonNullable<DashboardSession["pr"]>["mergeability"] = {
    mergeable: false,
    ciPassing: false,
    approved: false,
    noConflicts: true,
    blockers: [],
  };

  if (meta["mergeReadiness"]) {
    try {
      const parsed = JSON.parse(meta["mergeReadiness"]) as Record<string, unknown>;
      mergeability = {
        mergeable: Boolean(parsed["mergeable"]),
        ciPassing: Boolean(parsed["ciPassing"]),
        approved: Boolean(parsed["approved"]),
        noConflicts: parsed["noConflicts"] !== false,
        blockers: Array.isArray(parsed["blockers"]) ? (parsed["blockers"] as string[]) : [],
      };
    } catch {
      // ignore malformed JSON
    }
  }

  return {
    number: Number.isFinite(num) && num > 0 ? num : 0,
    url: prUrl,
    title: meta["prTitle"] ?? "",
    branch: meta["prHeadRef"] ?? meta["branch"] ?? "",
    baseBranch: meta["prBaseRef"] ?? "",
    isDraft: meta["prDraft"] === "1" || meta["prDraft"] === "true",
    state: (meta["prState"] as NonNullable<DashboardSession["pr"]>["state"]) || "open",
    ciStatus: (meta["ciStatus"] as NonNullable<DashboardSession["pr"]>["ciStatus"]) || "none",
    reviewDecision: (meta["reviewDecision"] as NonNullable<DashboardSession["pr"]>["reviewDecision"]) || "none",
    mergeability,
    previewUrl: meta["previewUrl"] ?? null,
  };
}

/** Build a DashboardSession from raw metadata (for archived sessions). */
function metadataToDashboard(id: string, meta: Record<string, string>, filePath: string): DashboardSession {
  const createdAt = meta["createdAt"] ?? new Date().toISOString();
  let lastActivityAt = createdAt;
  try {
    const st = statSync(filePath);
    lastActivityAt = st.mtime.toISOString();
  } catch {
    /* ignore */
  }

  return {
    id,
    projectId: meta["project"] ?? "unknown",
    status: (meta["status"] ?? "unknown") as DashboardSession["status"],
    activity: null,
    branch: meta["branch"] ?? null,
    issueId: null,
    summary: buildArchivedSummary(meta),
    createdAt,
    lastActivityAt,
    pr: parsePRFromMeta(meta),
    metadata: meta,
  };
}

/** Find session by scanning ~/.conductor directories (active + archive). */
function findSessionDirect(sessionId: string): DashboardSession | null {
  const conductorDir = join(homedir(), ".conductor");
  if (!existsSync(conductorDir)) return null;

  const projectDirs = safeSessionDirs(conductorDir);
  for (const projectDir of projectDirs) {
    const sessionsDir = join(conductorDir, projectDir, "sessions");
    if (!existsSync(sessionsDir)) continue;

    let sessionStat: { isDirectory: () => boolean } | null = null;
    try {
      sessionStat = statSync(sessionsDir);
    } catch {
      continue;
    }
    if (!sessionStat?.isDirectory()) continue;

    // Active session
    const activeFile = join(sessionsDir, sessionId);
    if (existsSync(activeFile)) {
      const meta = readMetadataFile(activeFile);
      if (meta) {
        return metadataToDashboard(sessionId, meta, activeFile);
      }
    }

    // Archived session
    const archiveDir = join(sessionsDir, "archive");
    if (!existsSync(archiveDir)) continue;

    const archiveFiles = safeSessionDirs(archiveDir)
      .filter((f) => f.startsWith(sessionId + "_"))
      .sort()
      .reverse();

    if (archiveFiles.length > 0) {
      const filePath = join(archiveDir, archiveFiles[0]!);
      const meta = readMetadataFile(filePath);
      if (meta) {
        return metadataToDashboard(sessionId, meta, filePath);
      }
    }
  }

  return null;
}

/** GET /api/sessions/:id -- Get a single session. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = await guardApiAccess();
    if (denied) return denied;
    const { id } = await params;
    const sessionId = id.trim();

    if (!sessionId) {
      return NextResponse.json({ error: "Session ID is required" }, { status: 400 });
    }
    if (!VALID_SESSION_ID.test(sessionId)) {
      return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
    }

    // Try active sessions first via session manager
    const { sessionManager } = await getServices();
    const session = await sessionManager.get(sessionId);
    if (session) {
      return NextResponse.json(sessionToDashboard(session));
    }

    // Fallback: direct filesystem scan (finds archived sessions too)
    const direct = findSessionDirect(sessionId);
    if (direct) {
      return NextResponse.json(direct);
    }

    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load session";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
