/**
 * tracker-github plugin — GitHub Issues as an issue tracker.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  ProjectConfig,
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
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${message}`, {
      cause: err,
    });
  }
}

function mapState(ghState: string, stateReason?: string | null): Issue["state"] {
  const s = ghState.toUpperCase();
  if (s === "CLOSED") {
    if (stateReason?.toUpperCase() === "NOT_PLANNED") return "cancelled";
    return "closed";
  }
  return "open";
}

/** Slugify an issue title for branch naming */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createGitHubTracker(): Tracker {
  return {
    name: "github",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const raw = await gh([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--json",
        "number,title,body,url,state,stateReason,labels",
      ]);

      let data: {
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason: string | null;
        labels: Array<{ name: string }>;
      };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Failed to parse gh output for getIssue: ${raw.slice(0, 200)}`);
      }

      return {
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const raw = await gh([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--json",
        "state",
      ]);
      let data: { state: string };
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`Failed to parse gh output for isCompleted: ${raw.slice(0, 200)}`);
      }
      return data.state.toUpperCase() === "CLOSED";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `https://github.com/${project.repo}/issues/${num}`;
    },

    branchName(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      // Use project's sessionPrefix for uniqueness if available
      const prefix = project.sessionPrefix || "feat";
      return `${prefix}/${num}-${slugify(identifier)}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on GitHub issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "tracker" as const,
  description: "Tracker plugin: GitHub Issues",
  version: "0.2.5",
};

export function create(): Tracker {
  return createGitHubTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
