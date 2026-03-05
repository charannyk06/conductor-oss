import { NextRequest, NextResponse } from "next/server";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { guardApiAccess } from "@/lib/auth";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

type GitHubRepo = {
  name: string;
  fullName: string;
  httpsUrl: string;
  sshUrl: string;
  defaultBranch: string;
  private: boolean;
};

type GhRepoListItem = {
  nameWithOwner?: string;
  url?: string;
  sshUrl?: string;
  isPrivate?: boolean;
  defaultBranchRef?: {
    name?: string;
  } | null;
};

async function assertGhAuthenticated(): Promise<void> {
  try {
    await execFileAsync("gh", ["auth", "status"], {
      timeout: 20_000,
      env: {
        ...process.env,
        GH_PAGER: "cat",
      },
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      throw new Error("GitHub CLI is not installed. Install `gh` and run `gh auth login`.");
    }
    throw new Error("GitHub CLI is not authenticated. Run `gh auth login` first.");
  }
}

export async function GET(request: NextRequest) {
  const denied = await guardApiAccess();
  if (denied) return denied;

  const query = request.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";

  try {
    await assertGhAuthenticated();

    const { stdout } = await execFileAsync(
      "gh",
      [
        "repo",
        "list",
        "--limit",
        "200",
        "--json",
        "nameWithOwner,url,sshUrl,isPrivate,defaultBranchRef",
      ],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          GH_PAGER: "cat",
        },
      },
    );

    const parsed = JSON.parse(stdout) as GhRepoListItem[];
    let repos: GitHubRepo[] = parsed
      .filter((item) => !!item.nameWithOwner)
      .map((item) => {
        const fullName = item.nameWithOwner ?? "";
        const name = fullName.split("/").pop() ?? fullName;
        const httpsUrl = item.url ? `${item.url}.git` : `https://github.com/${fullName}.git`;
        return {
          name,
          fullName,
          httpsUrl,
          sshUrl: item.sshUrl ?? `git@github.com:${fullName}.git`,
          defaultBranch: item.defaultBranchRef?.name ?? "main",
          private: item.isPrivate === true,
        };
      });

    if (query.length > 0) {
      repos = repos.filter((repo) => {
        return repo.fullName.toLowerCase().includes(query)
          || repo.name.toLowerCase().includes(query)
          || repo.defaultBranch.toLowerCase().includes(query);
      });
    }

    repos.sort((left, right) => left.fullName.localeCompare(right.fullName));

    return NextResponse.json({ repos });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list GitHub repositories";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
