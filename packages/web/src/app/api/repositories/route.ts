import { type NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";
import { syncWorkspaceSupportFiles } from "@conductor-oss/core";
import { getServices, invalidateServicesCache } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { normalizeRootProjectPaths, syncProjectLocalConfig } from "@/lib/projectConfigSync";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type MutableConfig = Record<string, unknown>;
type MutableProject = Record<string, unknown>;

type RepositoryPatchBody = {
  id?: unknown;
  displayName?: unknown;
  repo?: unknown;
  path?: unknown;
  agent?: unknown;
  agentModel?: unknown;
  defaultWorkingDirectory?: unknown;
  defaultBranch?: unknown;
  devServerScript?: unknown;
  setupScript?: unknown;
  runSetupInParallel?: unknown;
  cleanupScript?: unknown;
  archiveScript?: unknown;
  copyFiles?: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function toProjectMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function normalizeScriptArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return [];
}

function scriptArrayToText(value: unknown): string {
  return normalizeScriptArray(value).join("\n");
}

function normalizeCopyFiles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function copyFilesToText(value: unknown): string {
  return normalizeCopyFiles(value).join(", ");
}

function normalizeWorkingDirectory(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/g, "")
    .trim();

  if (!normalized || normalized === ".") return null;
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error("defaultWorkingDirectory must be a relative path inside the repository");
  }
  return normalized;
}

function extractRepoName(repoValue?: string | null): string | null {
  if (!repoValue || repoValue.trim().length === 0) return null;
  const raw = repoValue.trim();
  const sshMatch = raw.match(/^git@[^:]+:(.+)$/);
  const candidate = sshMatch ? sshMatch[1] : raw;

  try {
    const url = new URL(candidate);
    const parts = url.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    return parts[parts.length - 1] ?? null;
  } catch {
    const parts = candidate
      .replace(/\.git$/i, "")
      .split(/[/:]/)
      .filter(Boolean);
    return parts[parts.length - 1] ?? null;
  }
}

async function isGitRepository(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    await execFileAsync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

function uniqueCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    ordered.push(resolved);
  }
  return ordered;
}

async function maybeResolveCaseInsensitive(path: string): Promise<string | null> {
  const parent = dirname(path);
  const target = basename(path).toLowerCase();
  if (!existsSync(parent)) return null;

  try {
    const entries = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));

    for (const entry of entries) {
      if (basename(entry).toLowerCase() !== target) continue;
      if (await isGitRepository(entry)) return entry;
    }
  } catch {
    // Best effort only.
  }

  return null;
}

async function suggestRepoPath(projectPath: string, repoValue?: string | null): Promise<string | null> {
  const expandedProjectPath = expandHome(projectPath);
  if (await isGitRepository(expandedProjectPath)) return expandedProjectPath;

  const projectPathExt = extname(expandedProjectPath).toLowerCase();
  const repoName = extractRepoName(repoValue);

  const candidates = uniqueCandidates([
    expandedProjectPath,
    ...(projectPathExt ? [dirname(expandedProjectPath)] : []),
    ...(repoName ? [join(dirname(expandedProjectPath), repoName)] : []),
    ...(repoName ? [join(homedir(), ".openclaw", "projects", repoName)] : []),
    ...(repoName ? [join(homedir(), ".conductor", "projects", repoName)] : []),
    expandedProjectPath.replace("/workspace/projects/", "/projects/"),
    ...(repoName ? [join(homedir(), ".openclaw", "projects", repoName.toLowerCase())] : []),
  ]);

  for (const candidate of candidates) {
    if (await isGitRepository(candidate)) return candidate;
    const caseInsensitive = await maybeResolveCaseInsensitive(candidate);
    if (caseInsensitive) return caseInsensitive;
  }

  return null;
}

async function serializeRepository(projectId: string, project: Record<string, unknown>) {
  const path = asNonEmptyString(project["path"]) ?? "";
  const repo = asNonEmptyString(project["repo"]) ?? "";
  const agentConfig = toObject(project["agentConfig"]);
  const expandedPath = path ? expandHome(path) : "";
  const pathExists = expandedPath ? existsSync(expandedPath) : false;
  const gitRepository = expandedPath ? await isGitRepository(expandedPath) : false;
  const suggestedPath = path
    ? await suggestRepoPath(path, repo || null)
    : null;

  return {
    id: projectId,
    displayName: asNonEmptyString(project["name"]) ?? projectId,
    repo,
    path,
    agent: asNonEmptyString(project["agent"]) ?? "claude-code",
    agentModel: asNonEmptyString(agentConfig["model"]) ?? "",
    workspaceMode: asNonEmptyString(project["workspace"]) ?? "worktree",
    runtimeMode: asNonEmptyString(project["runtime"]) ?? "tmux",
    scmMode: asNonEmptyString(project["scm"]) ?? "github",
    defaultWorkingDirectory: asNonEmptyString(project["defaultWorkingDirectory"]) ?? "",
    defaultBranch: asNonEmptyString(project["defaultBranch"]) ?? "main",
    devServerScript: asNonEmptyString(toObject(project["devServer"])["command"]) ?? "",
    setupScript: scriptArrayToText(project["setupScript"] ?? project["postCreate"]),
    runSetupInParallel: project["runSetupInParallel"] === true,
    cleanupScript: scriptArrayToText(project["cleanupScript"]),
    archiveScript: scriptArrayToText(project["archiveScript"]),
    copyFiles: copyFilesToText(project["copyFiles"]),
    pathHealth: {
      exists: pathExists,
      isGitRepository: gitRepository,
      suggestedPath: suggestedPath && suggestedPath !== expandedPath ? suggestedPath : null,
    },
  };
}

export async function GET() {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  try {
    const { config } = await getServices();
    const repositories = await Promise.all(
      Object.entries(config.projects).map(async ([id, project]) => {
        return serializeRepository(id, project as unknown as Record<string, unknown>);
      }),
    );

    repositories.sort((left, right) => left.displayName.localeCompare(right.displayName));

    return NextResponse.json({ repositories });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load repositories";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const body = (await request.json().catch(() => null)) as RepositoryPatchBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = asNonEmptyString(body.id);
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const { config } = await getServices();
    const configPath = config.configPath;
    if (!configPath) {
      return NextResponse.json({ error: "Unable to resolve conductor config path" }, { status: 500 });
    }

    const originalConfigRaw = await readFile(configPath, "utf8");
    const parsed = (parse(originalConfigRaw) ?? {}) as MutableConfig;
    const nextRoot: MutableConfig =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...parsed }
        : {};

    const nextProjects = toProjectMap(nextRoot["projects"]);
    if (!(id in nextProjects)) {
      return NextResponse.json({ error: `Unknown repository id: ${id}` }, { status: 404 });
    }

    const existingProject = toObject(nextProjects[id]);
    const nextProject: MutableProject = { ...existingProject };

    const displayName = asNonEmptyString(body.displayName) ?? id;
    const repo = asNonEmptyString(body.repo);
    const path = asNonEmptyString(body.path);
    const agent = asNonEmptyString(body.agent) ?? asNonEmptyString(existingProject["agent"]) ?? "claude-code";
    const agentModel = asNonEmptyString(body.agentModel);
    const defaultBranch = asNonEmptyString(body.defaultBranch) ?? "main";
    const defaultWorkingDirectory = normalizeWorkingDirectory(asNonEmptyString(body.defaultWorkingDirectory));

    if (!repo) {
      return NextResponse.json({ error: "repo is required" }, { status: 400 });
    }
    if (!path) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    nextProject["name"] = displayName;
    nextProject["repo"] = repo;
    nextProject["path"] = expandHome(path);
    nextProject["agent"] = agent;
    nextProject["defaultBranch"] = defaultBranch;
    const nextAgentConfig = toObject(nextProject["agentConfig"]);
    if (agentModel) {
      nextProject["agentConfig"] = {
        ...nextAgentConfig,
        model: agentModel,
      };
    } else if ("model" in nextAgentConfig) {
      const { model: _removedModel, ...rest } = nextAgentConfig;
      nextProject["agentConfig"] = rest;
      if (Object.keys(rest).length === 0) {
        delete nextProject["agentConfig"];
      }
    }

    if (defaultWorkingDirectory) {
      nextProject["defaultWorkingDirectory"] = defaultWorkingDirectory;
    } else {
      delete nextProject["defaultWorkingDirectory"];
    }

    const devServerScript = asNonEmptyString(body.devServerScript);
    if (devServerScript) {
      const nextDevServer = toObject(nextProject["devServer"]);
      nextProject["devServer"] = {
        ...nextDevServer,
        command: devServerScript,
      };
    } else {
      delete nextProject["devServer"];
    }

    const setupCommands = normalizeScriptArray(body.setupScript);
    if (setupCommands.length > 0) {
      nextProject["setupScript"] = setupCommands;
      // Keep legacy key in sync for backward compatibility.
      nextProject["postCreate"] = setupCommands;
    } else {
      delete nextProject["setupScript"];
      delete nextProject["postCreate"];
    }

    nextProject["runSetupInParallel"] = body.runSetupInParallel === true;

    const cleanupCommands = normalizeScriptArray(body.cleanupScript);
    if (cleanupCommands.length > 0) {
      nextProject["cleanupScript"] = cleanupCommands;
    } else {
      delete nextProject["cleanupScript"];
    }

    const archiveCommands = normalizeScriptArray(body.archiveScript);
    if (archiveCommands.length > 0) {
      nextProject["archiveScript"] = archiveCommands;
    } else {
      delete nextProject["archiveScript"];
    }

    const copyFiles = normalizeCopyFiles(body.copyFiles);
    if (copyFiles.length > 0) {
      nextProject["copyFiles"] = copyFiles;
    } else {
      delete nextProject["copyFiles"];
    }

    nextProjects[id] = nextProject;
    nextRoot["projects"] = nextProjects;
    await normalizeRootProjectPaths(nextRoot);

    const updatedYaml = stringify(nextRoot, { lineWidth: 0 });
    await writeFile(configPath, updatedYaml, "utf8");

    try {
      invalidateServicesCache("repository settings updated");
      const { config: refreshedConfig, registry } = await getServices();
      await syncProjectLocalConfig(refreshedConfig as unknown as Record<string, unknown>, id);
      syncWorkspaceSupportFiles(refreshedConfig, {
        agentNames: registry.list("agent").map((agent) => agent.name),
      });
    } catch (err) {
      await writeFile(configPath, originalConfigRaw, "utf8");
      invalidateServicesCache("repository settings update rollback");
      throw err;
    }

    const saved = await serializeRepository(id, nextProject);
    return NextResponse.json({ repository: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update repository";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
