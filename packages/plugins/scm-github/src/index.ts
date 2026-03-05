/**
 * scm-github plugin — GitHub PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  SCM,
  Session,
  ProjectConfig,
  PRInfo,
  PRState,
  MergeMethod,
  CICheck,
  CIStatus,
  Review,
  ReviewDecision,
  MergeReadiness,
} from "@conductor-oss/core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Detect GitHub API rate limiting
    if (message.includes("rate limit") || message.includes("403") || message.includes("secondary rate")) {
      throw new Error(`gh rate limited: ${args.slice(0, 3).join(" ")}`, { cause: err });
    }
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${message}`, { cause: err });
  }
}

/** Safely parse JSON from gh CLI output, throwing a descriptive error on failure. */
function safeJsonParse<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse gh output for ${context}: ${raw.slice(0, 200)}`);
  }
}

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitHubSCM(): SCM {
  return {
    name: "github",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const parts = project.repo.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${project.repo}", expected "owner/repo"`);
      }
      const [owner, repo] = parts;

      try {
        const raw = await gh([
          "pr",
          "list",
          "--repo",
          project.repo,
          "--head",
          session.branch,
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft",
          "--limit",
          "1",
        ]);

        const prs = safeJsonParse<Array<{
          number: number;
          url: string;
          title: string;
          headRefName: string;
          baseRefName: string;
          isDraft: boolean;
        }>>(raw, "detectPR");

        if (prs.length === 0) return null;

        const pr = prs[0];
        return {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          owner,
          repo,
          branch: pr.headRefName,
          baseBranch: pr.baseRefName,
          isDraft: pr.isDraft,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state",
      ]);
      const data = safeJsonParse<{ state: string }>(raw, "getPRState");
      const s = data.state.toUpperCase();
      if (s === "MERGED") return "merged";
      if (s === "CLOSED") return "closed";
      return "open";
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";
      await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag, "--delete-branch"]);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const raw = await gh([
          "pr",
          "checks",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "name,state,link",
        ]);

        const checks = safeJsonParse<Array<{
          name: string;
          state: string;
          link: string;
        }>>(raw, "getCIChecks");

        return checks.map((c) => {
          let status: CICheck["status"];
          const state = c.state?.toUpperCase();

          if (state === "PENDING" || state === "QUEUED") {
            status = "pending";
          } else if (state === "IN_PROGRESS") {
            status = "running";
          } else if (state === "SUCCESS") {
            status = "passed";
          } else if (
            state === "FAILURE" ||
            state === "TIMED_OUT" ||
            state === "CANCELLED" ||
            state === "ACTION_REQUIRED"
          ) {
            status = "failed";
          } else if (state === "SKIPPED" || state === "NEUTRAL") {
            status = "skipped";
          } else {
            status = "failed";
          }

          return {
            name: c.name,
            status,
            url: c.link || undefined,
          };
        });
      } catch (err) {
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Rate-limited or transient failure — don't falsely report "failing"
        if (message.includes("rate limit")) return "pending";
        // Before fail-closing, check if the PR is merged/closed
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch {
          // Can't determine state either — return pending, not failing
          return "pending";
        }
        return "failing";
      }

      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return "pending";

      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return "none";

      return "passing";
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviews",
      ]);
      const data = safeJsonParse<{
        reviews: Array<{
          author: { login: string };
          state: string;
          body: string;
          submittedAt: string;
        }>;
      }>(raw, "getReviews");

      return data.reviews.map((r) => {
        let state: Review["state"];
        const s = r.state?.toUpperCase();
        if (s === "APPROVED") state = "approved";
        else if (s === "CHANGES_REQUESTED") state = "changes_requested";
        else if (s === "DISMISSED") state = "dismissed";
        else if (s === "PENDING") state = "pending";
        else state = "commented";

        return {
          author: r.author?.login ?? "unknown",
          state,
          body: r.body || undefined,
          submittedAt: parseDate(r.submittedAt),
        };
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviewDecision",
      ]);
      const data = safeJsonParse<{ reviewDecision: string }>(raw, "getReviewDecision");

      const d = (data.reviewDecision ?? "").toUpperCase();
      if (d === "APPROVED") return "approved";
      if (d === "CHANGES_REQUESTED") return "changes_requested";
      if (d === "REVIEW_REQUIRED") return "pending";
      return "none";
    },

    async getDeploymentPreviewUrl(pr: PRInfo): Promise<string | null> {
      try {
        const { stdout } = await execFileAsync("gh", [
          "pr",
          "checks",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "name,link,state",
        ], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });

        const checks = safeJsonParse<Array<{
          name: string;
          link: string;
          state: string;
        }>>(stdout.trim(), "getDeploymentPreviewUrl");

        const deployKeywords = /vercel|netlify|preview|deploy/i;
        const previewUrlPattern = /vercel\.app|netlify\.app|preview/i;

        for (const check of checks) {
          if (deployKeywords.test(check.name) && check.link && previewUrlPattern.test(check.link)) {
            return check.link;
          }
        }

        return null;
      } catch {
        return null;
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      // Check if the PR is merged — skip further checks
      const state = await this.getPRState(pr);
      if (state === "merged") {
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

      // Fetch PR details with merge state
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "mergeable,reviewDecision,mergeStateStatus,isDraft",
      ]);

      const data = safeJsonParse<{
        mergeable: string;
        reviewDecision: string;
        mergeStateStatus: string;
        isDraft: boolean;
      }>(raw, "getMergeability");

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === "passing" || ciStatus === "none";
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = (data.reviewDecision ?? "").toUpperCase();
      const approved = reviewDecision === "APPROVED";
      if (reviewDecision === "CHANGES_REQUESTED") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "REVIEW_REQUIRED") {
        blockers.push("Review required");
      }

      // Conflicts / merge state
      const mergeable = (data.mergeable ?? "").toUpperCase();
      const mergeState = (data.mergeStateStatus ?? "").toUpperCase();
      const noConflicts = mergeable === "MERGEABLE";
      if (mergeable === "CONFLICTING") {
        blockers.push("Merge conflicts");
      } else if (mergeable === "UNKNOWN" || mergeable === "") {
        blockers.push("Merge status unknown (GitHub is computing)");
      }
      if (mergeState === "BEHIND") {
        blockers.push("Branch is behind base branch");
      } else if (mergeState === "BLOCKED") {
        blockers.push("Merge is blocked by branch protection");
      } else if (mergeState === "UNSTABLE") {
        blockers.push("Required checks are failing");
      }

      // Draft
      if (data.isDraft) {
        blockers.push("PR is still a draft");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "scm" as const,
  description: "SCM plugin: GitHub PRs, CI checks, reviews, merge readiness",
  version: "0.2.0",
};

export function create(): SCM {
  return createGitHubSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
