import { NextRequest, NextResponse } from "next/server";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { guardApiAccess } from "@/lib/auth";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

function asNonEmpty(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function dedupeAndSortBranches(branches: string[]): string[] {
  const normalized = branches
    .map((branch) => branch.trim())
    .filter((branch) => branch.length > 0)
    .map((branch) => branch.replace(/^origin\//, ""));

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

async function readRemoteDefaultBranch(gitUrl: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", "--symref", gitUrl, "HEAD"],
      { timeout: 30_000 },
    );
    const line = stdout
      .split("\n")
      .find((entry) => entry.startsWith("ref: refs/heads/"));
    if (!line) return null;
    const match = line.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function listRemoteBranches(gitUrl: string): Promise<{ branches: string[]; defaultBranch: string | null }> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-remote", "--heads", "--refs", gitUrl],
    { timeout: 30_000 },
  );

  const branches = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const ref = line.split("\t")[1] ?? "";
      return ref.replace("refs/heads/", "");
    })
    .filter(Boolean);

  const defaultBranch = await readRemoteDefaultBranch(gitUrl);
  return {
    branches: dedupeAndSortBranches(branches),
    defaultBranch,
  };
}

async function listLocalBranches(path: string): Promise<{ branches: string[]; defaultBranch: string | null }> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", path, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
    { timeout: 20_000 },
  );

  const defaultBranchRaw = await execFileAsync(
    "git",
    ["-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { timeout: 20_000 },
  ).then((result) => result.stdout.trim()).catch(() => "");

  const branches = stdout.split("\n").filter(Boolean);
  const defaultBranch = defaultBranchRaw.startsWith("origin/")
    ? defaultBranchRaw.slice("origin/".length)
    : null;

  return {
    branches: dedupeAndSortBranches(branches),
    defaultBranch,
  };
}

export async function GET(request: NextRequest) {
  const denied = await guardApiAccess();
  if (denied) return denied;

  const gitUrl = asNonEmpty(request.nextUrl.searchParams.get("gitUrl"));
  const rawPath = asNonEmpty(request.nextUrl.searchParams.get("path"));

  if (!gitUrl && !rawPath) {
    return NextResponse.json({ error: "Provide either gitUrl or path" }, { status: 400 });
  }

  try {
    if (rawPath) {
      const path = expandHome(rawPath);
      const payload = await listLocalBranches(path);
      return NextResponse.json({ ...payload, source: "local" });
    }

    const payload = await listRemoteBranches(gitUrl!);
    return NextResponse.json({ ...payload, source: "remote" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load branches";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
