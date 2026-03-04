import { type NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { generateSessionPrefix } from "@conductor-oss/core";
import { getServices, invalidateServicesCache } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";

const execFileAsync = promisify(execFile);

type WorkspaceCreateMode = "git" | "local";

type WorkspaceRequestBody = {
  mode?: unknown;
  projectId?: unknown;
  agent?: unknown;
  defaultBranch?: unknown;
  gitUrl?: unknown;
  path?: unknown;
  initializeGit?: unknown;
};

type MutableConfig = Record<string, unknown>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function slugifyProjectId(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "workspace";
}

function ensureUniqueProjectId(baseId: string, existingIds: Set<string>): string {
  if (!existingIds.has(baseId)) return baseId;
  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

function extractRepoNameFromGitUrl(gitUrl: string): string | null {
  const sshMatch = gitUrl.match(/^git@[^:]+:(.+)$/);
  const candidate = sshMatch ? sshMatch[1] : gitUrl;

  try {
    const url = new URL(candidate);
    const segments = url.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }
    if (segments.length === 1) {
      return segments[0];
    }
    return null;
  } catch {
    const normalized = candidate.replace(/\.git$/i, "");
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }
    return segments[segments.length - 1] ?? null;
  }
}

function deriveProjectIdFromInputs(params: {
  providedId: string | null;
  gitUrl: string | null;
  path: string | null;
}): string {
  if (params.providedId) return slugifyProjectId(params.providedId);

  const fromRepo = params.gitUrl
    ? extractRepoNameFromGitUrl(params.gitUrl)?.split("/").pop() ?? null
    : null;
  if (fromRepo) return slugifyProjectId(fromRepo);

  const fromPath = params.path ? basename(params.path) : null;
  if (fromPath) return slugifyProjectId(fromPath);

  return "workspace";
}

function inferBaseProjectsDir(existingPaths: string[]): string {
  const counts = new Map<string, number>();

  for (const rawPath of existingPaths) {
    const resolvedPath = expandHome(rawPath);
    const isLikelyFile = /\.[a-z0-9]+$/i.test(basename(resolvedPath));
    const dir = isLikelyFile ? dirname(resolvedPath) : dirname(resolvedPath) === resolvedPath ? resolvedPath : dirname(resolvedPath);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  const best = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  return best ?? resolve(homedir(), ".openclaw", "workspace", "projects");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout: 90_000,
  });
  return result.stdout.trim();
}

async function isGitRepository(path: string): Promise<boolean> {
  try {
    await runGit(path, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function detectDefaultBranch(path: string, fallback: string): Promise<string> {
  try {
    const remoteHead = await runGit(path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (remoteHead.startsWith("origin/")) {
      return remoteHead.slice("origin/".length);
    }
  } catch {
    // Ignore remote-less repos.
  }

  try {
    const head = await runGit(path, ["symbolic-ref", "--short", "HEAD"]);
    if (head.length > 0 && head !== "HEAD") return head;
  } catch {
    // Detached or empty repository.
  }

  return fallback;
}

async function ensureInitialCommit(path: string): Promise<void> {
  let hasCommit = true;
  try {
    await runGit(path, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasCommit = false;
  }

  if (hasCommit) return;

  await runGit(path, ["add", "-A"]);
  await runGit(path, ["-c", "user.name=Conductor", "-c", "user.email=conductor@local", "commit", "--allow-empty", "-m", "chore: initialize workspace"]);
}

async function initializeGitRepository(path: string, branch: string): Promise<void> {
  try {
    await runGit(path, ["init", "-b", branch]);
  } catch {
    await runGit(path, ["init"]);
    try {
      await runGit(path, ["checkout", "-b", branch]);
    } catch {
      // Branch may already exist.
    }
  }
  await ensureInitialCommit(path);
}

async function getOriginRepo(path: string): Promise<string | null> {
  try {
    const remote = await runGit(path, ["remote", "get-url", "origin"]);
    return extractRepoNameFromGitUrl(remote) ?? remote;
  } catch {
    return null;
  }
}

function toProjectMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function buildProjectPayload(args: {
  path: string;
  repo: string;
  defaultBranch: string;
  agent: string;
  sessionPrefix: string;
}): Record<string, unknown> {
  return {
    path: args.path,
    repo: args.repo,
    defaultBranch: args.defaultBranch,
    agent: args.agent,
    sessionPrefix: args.sessionPrefix,
    workspace: "worktree",
    runtime: "tmux",
  };
}

function getExistingPathBasenames(existingPaths: string[]): Set<string> {
  return new Set(existingPaths.map((path) => basename(expandHome(path))).filter(Boolean));
}

function getExistingSessionPrefixes(
  projects: Record<string, { path: string; sessionPrefix?: string }>,
): Set<string> {
  const prefixes = new Set<string>();
  for (const project of Object.values(projects)) {
    const current = typeof project.sessionPrefix === "string" && project.sessionPrefix.trim().length > 0
      ? project.sessionPrefix.trim()
      : generateSessionPrefix(basename(expandHome(project.path)));
    if (current) prefixes.add(current);
  }
  return prefixes;
}

function createUniqueSessionPrefix(
  projectPath: string,
  projects: Record<string, { path: string; sessionPrefix?: string }>,
): string {
  const used = getExistingSessionPrefixes(projects);
  const base = generateSessionPrefix(basename(projectPath));
  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base}${suffix}`)) {
    suffix += 1;
  }
  return `${base}${suffix}`;
}

async function writeProjectToConfig(args: {
  configPath: string;
  projectId: string;
  projectData: Record<string, unknown>;
}): Promise<void> {
  const originalConfigRaw = await readFile(args.configPath, "utf8");
  const parsed = (parse(originalConfigRaw) ?? {}) as MutableConfig;
  const nextRoot: MutableConfig =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...parsed }
      : {};

  const nextProjects = toProjectMap(nextRoot.projects);
  nextProjects[args.projectId] = args.projectData;
  nextRoot.projects = nextProjects;

  const updatedYaml = stringify(nextRoot, {
    lineWidth: 0,
  });

  await writeFile(args.configPath, updatedYaml, "utf8");

  try {
    invalidateServicesCache("workspace added");
    await getServices();
  } catch (err) {
    await writeFile(args.configPath, originalConfigRaw, "utf8");
    invalidateServicesCache("workspace add rollback");
    throw err;
  }
}

export const dynamic = "force-dynamic";

/**
 * GET /api/workspaces
 *
 * Returns all configured projects/workspaces from conductor.yaml.
 */
export async function GET() {
  const denied = await guardApiAccess();
  if (denied) return denied;

  try {
    const { config } = await getServices();
    const workspaces = Object.entries(config.projects).map(([id, project]) => ({
      id,
      path: project.path,
      repo: project.repo ?? null,
      defaultBranch: project.defaultBranch ?? "main",
      agent: project.agent ?? config.defaults.agent,
    }));
    return NextResponse.json({ workspaces });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list workspaces";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/workspaces
 *
 * Adds a new project to conductor.yaml and prepares the backing repo path.
 * Supports both remote git clone and local/non-git folders.
 */
export async function POST(request: NextRequest) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const body = (await request.json().catch(() => null)) as WorkspaceRequestBody | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = asNonEmptyString(body.mode) as WorkspaceCreateMode | null;
  if (mode !== "git" && mode !== "local") {
    return NextResponse.json({ error: "mode must be either 'git' or 'local'" }, { status: 400 });
  }

  const requestedDefaultBranch = asNonEmptyString(body.defaultBranch) ?? "main";
  const gitUrl = asNonEmptyString(body.gitUrl);
  const rawPath = asNonEmptyString(body.path);
  const initializeGit = body.initializeGit === true;

  try {
    const { config } = await getServices();
    const configPath = config.configPath;
    if (!configPath) {
      return NextResponse.json(
        { error: "Unable to resolve conductor config path" },
        { status: 500 },
      );
    }

    const requestedAgent = asNonEmptyString(body.agent) ?? config.defaults.agent;
    const existingProjectIds = new Set(Object.keys(config.projects));
    const existingProjectPaths = Object.values(config.projects).map((project) => project.path);
    const existingPathBasenames = getExistingPathBasenames(existingProjectPaths);

    if (mode === "git") {
      if (!gitUrl) {
        return NextResponse.json({ error: "gitUrl is required for mode=git" }, { status: 400 });
      }

      const initialProjectId = deriveProjectIdFromInputs({
        providedId: asNonEmptyString(body.projectId),
        gitUrl,
        path: rawPath,
      });
      const projectId = ensureUniqueProjectId(initialProjectId, existingProjectIds);

      const targetPath = rawPath
        ? expandHome(rawPath)
        : resolve(inferBaseProjectsDir(existingProjectPaths), projectId);
      const targetBasename = basename(targetPath);

      if (existingPathBasenames.has(targetBasename)) {
        return NextResponse.json(
          {
            error: `A project already uses basename '${targetBasename}'. Choose a different folder name.`,
          },
          { status: 409 },
        );
      }

      await mkdir(dirname(targetPath), { recursive: true });

      const targetStats = await stat(targetPath).catch(() => null);
      if (targetStats) {
        if (!targetStats.isDirectory()) {
          return NextResponse.json(
            { error: "Target path exists and is not a directory" },
            { status: 409 },
          );
        }

        if (!(await isGitRepository(targetPath))) {
          return NextResponse.json(
            { error: "Target path already exists and is not a git repository" },
            { status: 409 },
          );
        }
      } else {
        await execFileAsync("git", ["clone", gitUrl, targetPath], { timeout: 120_000 });
      }

      const defaultBranch = await detectDefaultBranch(targetPath, requestedDefaultBranch);
      const repoValue = extractRepoNameFromGitUrl(gitUrl) ?? gitUrl;
      const sessionPrefix = createUniqueSessionPrefix(targetPath, config.projects);

      await writeProjectToConfig({
        configPath,
        projectId,
        projectData: buildProjectPayload({
          path: targetPath,
          repo: repoValue,
          defaultBranch,
          agent: requestedAgent,
          sessionPrefix,
        }),
      });

      return NextResponse.json(
        {
          project: {
            id: projectId,
            path: targetPath,
            repo: repoValue,
            defaultBranch,
            agent: requestedAgent,
          },
        },
        { status: 201 },
      );
    }

    if (!rawPath) {
      return NextResponse.json({ error: "path is required for mode=local" }, { status: 400 });
    }

    const localPath = expandHome(rawPath);
    const localStats = await stat(localPath).catch(() => null);
    if (!localStats || !localStats.isDirectory()) {
      return NextResponse.json(
        { error: "path must point to an existing directory" },
        { status: 400 },
      );
    }

    const localBasename = basename(localPath);
    if (existingPathBasenames.has(localBasename)) {
      return NextResponse.json(
        { error: `A project already uses basename '${localBasename}'. Choose a different folder.` },
        { status: 409 },
      );
    }

    let gitRepo = await isGitRepository(localPath);
    if (!gitRepo && initializeGit) {
      await initializeGitRepository(localPath, requestedDefaultBranch);
      gitRepo = true;
    }

    if (!gitRepo) {
      return NextResponse.json(
        {
          error: "Selected folder is not a git repository. Enable git initialization to use it as a workspace.",
        },
        { status: 400 },
      );
    }

    const defaultBranch = await detectDefaultBranch(localPath, requestedDefaultBranch);
    const initialProjectId = deriveProjectIdFromInputs({
      providedId: asNonEmptyString(body.projectId),
      gitUrl: null,
      path: localPath,
    });
    const projectId = ensureUniqueProjectId(initialProjectId, existingProjectIds);

    const repoValue = (await getOriginRepo(localPath)) ?? `local-${projectId}`;
    const sessionPrefix = createUniqueSessionPrefix(localPath, config.projects);

    await writeProjectToConfig({
      configPath,
      projectId,
      projectData: buildProjectPayload({
        path: localPath,
        repo: repoValue,
        defaultBranch,
        agent: requestedAgent,
        sessionPrefix,
      }),
    });

    return NextResponse.json(
      {
        project: {
          id: projectId,
          path: localPath,
          repo: repoValue,
          defaultBranch,
          agent: requestedAgent,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create workspace";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
