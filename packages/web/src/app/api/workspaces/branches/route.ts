import { NextRequest, NextResponse } from "next/server";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { guardApiAccess } from "@/lib/auth";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const ALLOWED_LOCAL_REPO_ROOTS = [homedir(), "/Volumes"];
const ALLOWED_REMOTE_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:"]);

function asNonEmpty(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

class InputError extends Error {}

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function isWithinAllowedRoots(path: string): boolean {
  return ALLOWED_LOCAL_REPO_ROOTS.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function normalizeScpStyleRemote(value: string): string | null {
  const match = value.match(
    /^(?<user>[A-Za-z0-9._-]+)@(?<host>[A-Za-z0-9.-]+):(?<repo>[A-Za-z0-9._~/-]+(?:\.git)?)$/,
  );
  if (!match?.groups) return null;
  const { user, host, repo } = match.groups;
  return `ssh://${user}@${host}/${repo}`;
}

function normalizeGitRemote(rawValue: string): string {
  if (/[\0\r\n]/.test(rawValue) || rawValue.startsWith("-")) {
    throw new InputError("Invalid gitUrl");
  }

  const candidate = normalizeScpStyleRemote(rawValue) ?? rawValue;
  const url = new URL(candidate);

  if (!ALLOWED_REMOTE_PROTOCOLS.has(url.protocol) || !url.hostname || url.search || url.hash) {
    throw new InputError("Unsupported gitUrl");
  }

  if (url.hostname.startsWith("-")) {
    throw new InputError("Unsupported gitUrl");
  }

  const normalizedPathname = url.pathname.replace(/\/+$/, "");
  if (normalizedPathname.length <= 1) {
    throw new InputError("gitUrl must include a repository path");
  }

  const normalized = new URL(`${url.protocol}//${url.host}${normalizedPathname}`);
  if (url.username) {
    normalized.username = url.username;
  }
  return normalized.toString();
}

async function resolveLocalRepoPath(rawPath: string): Promise<string> {
  const requestedPath = expandHome(rawPath);
  if (!isWithinAllowedRoots(requestedPath)) {
    throw new InputError("Path is outside the allowed repository roots");
  }

  const canonicalPath = await realpath(requestedPath);
  if (!isWithinAllowedRoots(canonicalPath)) {
    throw new InputError("Path is outside the allowed repository roots");
  }

  const pathStat = await stat(canonicalPath);
  if (!pathStat.isDirectory()) {
    throw new InputError("Path must be a directory");
  }

  return canonicalPath;
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
      ["ls-remote", "--symref", "--", gitUrl, "HEAD"],
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
    ["ls-remote", "--heads", "--refs", "--", gitUrl],
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
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
    { timeout: 20_000, cwd: path },
  );

  const defaultBranchRaw = await execFileAsync(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { timeout: 20_000, cwd: path },
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
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  const gitUrl = asNonEmpty(request.nextUrl.searchParams.get("gitUrl"));
  const rawPath = asNonEmpty(request.nextUrl.searchParams.get("path"));

  if (!gitUrl && !rawPath) {
    return NextResponse.json({ error: "Provide either gitUrl or path" }, { status: 400 });
  }

  try {
    if (rawPath) {
      const path = await resolveLocalRepoPath(rawPath);
      const payload = await listLocalBranches(path);
      return NextResponse.json({ ...payload, source: "local" });
    }

    const payload = await listRemoteBranches(normalizeGitRemote(gitUrl!));
    return NextResponse.json({ ...payload, source: "remote" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load branches";
    const status = err instanceof InputError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
