import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

type MutableConfig = Record<string, unknown>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toObject(value: unknown): Record<string, unknown> {
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeProjectConfigMap(value: unknown): Record<string, Record<string, unknown>> {
  const root = toObject(value);
  return Object.fromEntries(
    Object.entries(root).map(([projectId, project]) => [projectId, toObject(project)]),
  );
}

function resolveConfiguredProjectPath(value: string): string {
  if (value.startsWith("~/")) {
    return expandHome(value);
  }
  return resolve(value);
}

function backendBaseUrl(): string {
  const backendUrl = process.env.CONDUCTOR_BACKEND_URL?.trim();
  if (!backendUrl) {
    throw new Error("Rust backend URL is not configured");
  }
  return backendUrl;
}

async function requestProjectSetup(projectId: string): Promise<void> {
  const response = await fetch(
    new URL(`/api/projects/${encodeURIComponent(projectId)}/setup`, backendBaseUrl()),
    {
      method: "POST",
      cache: "no-store",
    },
  );
  if (response.ok) {
    return;
  }

  const body = await response.text().catch(() => "");
  throw new Error(body || `Failed to sync project ${projectId}: ${response.status}`);
}

export async function normalizeRootProjectPaths(rootConfig: MutableConfig): Promise<void> {
  const projects = normalizeProjectConfigMap(rootConfig["projects"]);

  for (const [projectId, rawProject] of Object.entries(projects)) {
    const project = toObject(rawProject);
    const rawProjectPath = asNonEmptyString(project["path"]);
    if (!rawProjectPath) {
      continue;
    }

    const resolvedProjectPath = resolveConfiguredProjectPath(rawProjectPath);

    if (!await isDirectory(resolvedProjectPath)) {
      continue;
    }

    projects[projectId] = {
      ...project,
      path: resolvedProjectPath,
    };
  }

  rootConfig["projects"] = projects;
}

export async function syncProjectLocalConfig(rootConfig: MutableConfig, projectId: string): Promise<void> {
  const projects = normalizeProjectConfigMap(rootConfig["projects"]);
  const project = toObject(projects[projectId]);
  const rawProjectPath = asNonEmptyString(project["path"]);
  if (!rawProjectPath) {
    return;
  }
  const projectPath = resolveConfiguredProjectPath(rawProjectPath);
  if (!await isDirectory(projectPath)) {
    return;
  }

  await requestProjectSetup(projectId);
}

export async function syncAllProjectLocalConfigs(rootConfig: MutableConfig): Promise<void> {
  await normalizeRootProjectPaths(rootConfig);
  const projects = normalizeProjectConfigMap(rootConfig["projects"]);
  for (const projectId of Object.keys(projects)) {
    await syncProjectLocalConfig(rootConfig, projectId);
  }
}
