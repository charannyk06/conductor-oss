import { existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type ReviewDiffKind = "meta" | "hunk" | "context" | "add" | "remove" | "info";
type ReviewDiffSource = "working-tree" | "remote-pr" | "not-found";

interface ReviewDiffLine {
  kind: ReviewDiffKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface ReviewDiffFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copy" | "binary" | "unknown";
  additions: number;
  deletions: number;
  lines: ReviewDiffLine[];
}

interface ReviewDiffPayload {
  hasDiff: boolean;
  generatedAt: string;
  source: ReviewDiffSource;
  truncated: boolean;
  files: ReviewDiffFile[];
  untracked: string[];
}

interface InternalReviewDiffFile extends ReviewDiffFile {
  oldPath: string;
  newPath: string;
}

function stripQuotedPath(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeDiffPath(value: string): string {
  const normalized = stripQuotedPath(value)
    .replace(/\\ /g, " ")
    .replace(/^a\//, "")
    .replace(/^b\//, "")
    .trim();
  return normalized;
}

function parseRepoFromText(value: string | undefined | null): { owner?: string; repo?: string } {
  if (!value) return {};
  const stripped = value.replace(/^https?:\/\/github\.com\//, "").split("/").filter(Boolean);
  if (stripped.length < 2) return {};
  return { owner: stripped[0], repo: stripped[1] };
}

function parsePrNumber(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = /\/pull\/(\d+)/.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getSessionPrForDiff(
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
): { owner: string; repo: string; number: number; url: string } | null {
  if (!session.pr) return null;

  let owner = session.pr.owner;
  let repo = session.pr.repo;

  const parsedNumber = parsePrNumber(session.pr.url);
  const number = Number.isFinite(session.pr.number) ? session.pr.number : parsedNumber;
  if (number == null) return null;

  if ((!owner || !repo) && session.pr.url) {
    const parsed = parseRepoFromText(session.pr.url);
    owner = owner ?? parsed.owner;
    repo = repo ?? parsed.repo;
  }
  if ((!owner || !repo) && fallbackRepo) {
    const parsed = parseRepoFromText(fallbackRepo);
    owner = owner ?? parsed.owner;
    repo = repo ?? parsed.repo;
  }
  if (!owner || !repo) return null;

  return {
    owner,
    repo,
    number,
    url: session.pr.url || `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

function parseUntrackedFiles(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function parseGitDiff(raw: string): InternalReviewDiffFile[] {
  const lines = raw.split(/\r?\n/);
  const files: InternalReviewDiffFile[] = [];

  let active: InternalReviewDiffFile | null = null;
  let oldLine = 1;
  let newLine = 1;

  const flush = () => {
    if (!active) return;
    files.push(active);
    active = null;
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.startsWith("diff --git ")) {
      flush();

      const match = /diff --git (a\/.+) (b\/.+)/.exec(line);
      if (!match) continue;

      const oldPath = normalizeDiffPath(match[1].slice(2));
      const newPath = normalizeDiffPath(match[2].slice(2));
      const initialPath = newPath === "/dev/null" ? oldPath : newPath;
      const initialStatus = oldPath !== newPath && newPath !== "/dev/null" && oldPath !== "/dev/null"
        ? "renamed"
        : "modified";

      active = {
        path: initialPath,
        oldPath,
        newPath,
        status: initialStatus,
        additions: 0,
        deletions: 0,
        lines: [],
      };
      oldLine = 1;
      newLine = 1;
      continue;
    }

    if (!active) continue;

    if (line.startsWith("index ")) {
      continue;
    }

    if (line.startsWith("new file mode ")) {
      active.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      active.status = "deleted";
      continue;
    }
    if (line.startsWith("old mode ")) {
      active.status = "modified";
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }
    if (line.startsWith("Binary files ")) {
      active.status = "binary";
      active.lines.push({ kind: "info", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (line.startsWith("rename from ")) {
      active.status = "renamed";
      active.oldPath = normalizeDiffPath(line.slice(11));
      continue;
    }

    if (line.startsWith("rename to ")) {
      active.status = "renamed";
      active.newPath = normalizeDiffPath(line.slice(9));
      active.path = active.newPath;
      continue;
    }

    if (line.startsWith("copy from ")) {
      active.status = "copy";
      active.oldPath = normalizeDiffPath(line.slice(9));
      continue;
    }

    if (line.startsWith("copy to ")) {
      active.status = "copy";
      active.newPath = normalizeDiffPath(line.slice(8));
      active.path = active.newPath;
      continue;
    }

    const hunkMatch = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/.exec(line);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[3], 10);
      active.lines.push({ kind: "hunk", oldLine: null, newLine: null, text: line });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      active.lines.push({ kind: "add", oldLine: null, newLine, text: line.slice(1) });
      active.additions += 1;
      newLine += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      active.lines.push({ kind: "remove", oldLine, newLine: null, text: line.slice(1) });
      active.deletions += 1;
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      const text = line.slice(1);
      active.lines.push({ kind: "context", oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (line.startsWith("\\")) {
      active.lines.push({ kind: "meta", oldLine: null, newLine: null, text: line });
      continue;
    }
  }

  flush();
  return files;
}

function buildPayload(rawDiff: string, untracked: string[], source: ReviewDiffSource): ReviewDiffPayload {
  const parsed = parseGitDiff(rawDiff);
  const files: ReviewDiffFile[] = parsed.map((file) => ({
    path: file.path || file.newPath || file.oldPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    lines: file.lines.map((line) => ({
      ...line,
      text: line.text.trimEnd(),
    })),
  }));
  const hasDiff = files.length > 0 || untracked.length > 0;

  return {
    hasDiff,
    generatedAt: new Date().toISOString(),
    source,
    truncated: false,
    files,
    untracked,
  };
}

async function loadRemotePrDiff(pr: { owner: string; repo: string; number: number }): Promise<string> {
  const { stdout } = await execFileAsync(
    "gh",
    ["pr", "diff", String(pr.number), "--repo", `${pr.owner}/${pr.repo}`],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout;
}

async function loadSessionWorkingDiff(
  workspacePath: string,
  baseBranch?: string | null,
): Promise<{ diff: string; status: string }> {
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
    throw new Error(`Session workspace not found: ${workspacePath}`);
  }

  try {
    const [diffResult, statusResult] = await Promise.all([
      execFileAsync("git", ["-C", workspacePath, "diff", "--no-color", "--no-ext-diff"], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }),
      execFileAsync("git", ["-C", workspacePath, "status", "--short", "--untracked-files=all"], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }),
    ]);

    // If working-tree diff is empty (all changes committed), diff against base branch
    if (!diffResult.stdout.trim() && baseBranch) {
      // Prefer local base branch (tracks the fork point more accurately than origin)
      const branches = [
        baseBranch,
        `origin/${baseBranch}`,
        "main",
        "origin/main",
        "master",
        "origin/master",
      ];
      for (const base of branches) {
        try {
          const branchDiff = await execFileAsync(
            "git",
            ["-C", workspacePath, "diff", `${base}...HEAD`, "--no-color", "--no-ext-diff"],
            { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
          );
          if (branchDiff.stdout.trim()) {
            return { diff: branchDiff.stdout, status: statusResult.stdout };
          }
        } catch {
          // Base ref doesn't exist in this worktree — try next
        }
      }
    }

    return {
      diff: diffResult.stdout,
      status: statusResult.stdout,
    };
  } catch (err) {
    if (err instanceof Error && (err.message.includes("not a git repository") || err.message.includes("fatal: not a git repository"))) {
      throw new Error("Session workspace is not a git repository");
    }
    throw err;
  }
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess();
  if (denied) return denied;

  const { id } = await context.params;
  const sessionId = decodeURIComponent(id ?? "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  try {
    const { sessionManager, config } = await getServices();
    const session = await sessionManager.get(sessionId);
    if (!session) {
      return NextResponse.json({ error: `Session ${sessionId} not found` }, { status: 404 });
    }
    const project = config.projects[session.projectId];
    const sessionPr = getSessionPrForDiff(session, project?.repo);

    const workspacePath = session.workspacePath ?? session.metadata["worktree"];
    if (workspacePath) {
      try {
        const baseBranch = project?.defaultBranch ?? session.metadata["baseBranch"] ?? "main";
        const { diff, status } = await loadSessionWorkingDiff(workspacePath, baseBranch);
        const payload = buildPayload(diff, parseUntrackedFiles(status), "working-tree");
        return NextResponse.json(payload);
      } catch (err) {
        if (sessionPr) {
          try {
            const remoteDiff = await loadRemotePrDiff(sessionPr);
            const payload = buildPayload(remoteDiff, [], "remote-pr");
            return NextResponse.json(payload);
          } catch (remoteErr) {
            console.error(`Failed to load remote PR diff for ${sessionId}`, remoteErr);
          }
        }
        const message = err instanceof Error ? err.message : "Failed to load review diff";
        return NextResponse.json({ error: message }, { status: 404 });
      }
    }

    if (!sessionPr) {
      return NextResponse.json(
        { error: "Session does not have a workspace path or PR reference for diff review" },
        { status: 404 },
      );
    }

    try {
      const remoteDiff = await loadRemotePrDiff(sessionPr);
      const payload = buildPayload(remoteDiff, [], "remote-pr");
      return NextResponse.json(payload);
    } catch (err) {
      console.error(`Failed to load remote PR diff for ${sessionId}`, err);
      const message = err instanceof Error ? err.message : "Failed to load review diff";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load review diff";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
