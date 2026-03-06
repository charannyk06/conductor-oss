import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { CIStatus, PRInfo, SCM, CICheck } from "@conductor-oss/core/types";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface SessionChecksResponse {
  sessionId: string;
  source: string;
  ciStatus: CIStatus;
  checks: Array<{
    name: string;
    status: "pending" | "running" | "passed" | "failed" | "skipped";
    url?: string;
  }>;
  generatedAt: string;
}

function getPrDetails(
  session: {
    pr?: {
      number: number;
      url: string;
      title?: string | null;
      owner?: string;
      repo?: string;
      branch?: string | null;
      baseBranch?: string;
      isDraft?: boolean;
    } | null;
    branch?: string | null;
  },
  fallbackRepo?: string,
): PRInfo | null {
  const parseRepoString = (value: string | undefined | null): { owner?: string; repo?: string } => {
    if (!value) return {};
    const trimmed = value.replace(/^https?:\/\/github\.com\//, "").split("/").filter(Boolean);
    if (trimmed.length < 2) return {};
    return { owner: trimmed[0], repo: trimmed[1] };
  };

  const parsePrNumber = (value: string | undefined | null): number | null => {
    if (!value) return null;
    const match = /\/pull\/(\d+)/.exec(value);
    if (!match?.[1]) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  if (!session.pr) return null;

  let owner = session.pr.owner;
  let repo = session.pr.repo;
  const parsedNumber = parsePrNumber(session.pr.url);
  const number = Number.isFinite(session.pr.number) ? session.pr.number : parsedNumber;
  if (number == null) {
    return null;
  }

  if ((!owner || !repo) && session.pr.url) {
    const parsedFromUrl = parseRepoString(session.pr.url);
    owner = owner ?? parsedFromUrl.owner;
    repo = repo ?? parsedFromUrl.repo;
  }

  if ((!owner || !repo) && fallbackRepo) {
    const parsedFromConfig = parseRepoString(fallbackRepo);
    owner = owner ?? parsedFromConfig.owner;
    repo = repo ?? parsedFromConfig.repo;
  }

  if (!owner || !repo) return null;

  return {
    number,
    url: session.pr.url || `https://github.com/${owner}/${repo}/pull/${number}`,
    title: session.pr.title ?? "",
    owner,
    repo,
    branch: session.pr.branch ?? session.branch ?? "",
    baseBranch: session.pr.baseBranch ?? "",
    isDraft: session.pr.isDraft ?? false,
  };
}

function getCheckSortValue(
  status: "pending" | "running" | "passed" | "failed" | "skipped",
): number {
  if (status === "failed") return 0;
  if (status === "pending" || status === "running") return 1;
  if (status === "skipped") return 2;
  return 3;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess(undefined, "viewer");
  const { id } = await context.params;
  if (denied) return denied;

  const sessionId = decodeURIComponent(id ?? "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  try {
    const { sessionManager, registry, config } = await getServices();
    const session = await sessionManager.get(sessionId);
    if (!session) {
      return NextResponse.json({ error: `Session ${sessionId} not found` }, { status: 404 });
    }

    const project = config.projects[session.projectId];
    const pr = getPrDetails(session, project?.repo);
    if (!pr) {
      return NextResponse.json(
        { error: "Session does not currently expose a PR URL to evaluate checks" },
        { status: 404 },
      );
    }

    const scmPluginName = project?.scm?.plugin ?? "github";
    const scmPlugin = registry.get<SCM>("scm", scmPluginName);
    if (!scmPlugin) {
      return NextResponse.json(
        { error: `SCM plugin '${scmPluginName}' is not configured` },
        { status: 500 },
      );
    }

    const ciStatus = await scmPlugin.getCISummary(pr).catch((): CIStatus => "pending" as CIStatus);

    let checks: Array<CICheck> = [];
    try {
      checks = await scmPlugin.getCIChecks(pr);
    } catch (err) {
      console.error("Failed to load CI checks", {
        sessionId,
        prNumber: pr.number,
        error: err instanceof Error ? err.message : `${err}`,
      });
    }

    const sorted = [...checks].sort((left, right) => {
      const leftScore = getCheckSortValue(left.status);
      const rightScore = getCheckSortValue(right.status);
      if (leftScore !== rightScore) return leftScore - rightScore;
      return left.name.localeCompare(right.name);
    });

    const payload: SessionChecksResponse = {
      sessionId,
      source: `${scmPluginName}:${scmPlugin.name}`,
      ciStatus,
      checks: sorted.map((check) => ({
        name: check.name,
        status: check.status,
        url: check.url,
      })),
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load CI checks";
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
