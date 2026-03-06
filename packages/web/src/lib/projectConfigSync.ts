import { join, resolve } from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  buildConductorYaml,
  resolveConfiguredProjectPath,
  type ScaffoldProjectConfig,
} from "@conductor-oss/core";

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

function normalizePreferences(value: unknown) {
  const root = toObject(value);
  const notifications = toObject(root["notifications"]);

  return {
    onboardingAcknowledged: root["onboardingAcknowledged"] === true,
    codingAgent: asNonEmptyString(root["codingAgent"]) ?? "claude-code",
    ide: asNonEmptyString(root["ide"]) ?? "vscode",
    remoteSshHost: asNonEmptyString(root["remoteSshHost"]),
    remoteSshUser: asNonEmptyString(root["remoteSshUser"]),
    markdownEditor: asNonEmptyString(root["markdownEditor"]) ?? "obsidian",
    notifications: {
      soundEnabled: notifications["soundEnabled"] !== false,
      soundFile: notifications["soundFile"] === null
        ? null
        : asNonEmptyString(notifications["soundFile"]) ?? "abstract-sound-4",
    },
  };
}

function buildProjectScaffold(
  projectId: string,
  project: Record<string, unknown>,
  projectPath: string,
): ScaffoldProjectConfig {
  const agentConfig = toObject(project["agentConfig"]);

  return {
    projectId,
    displayName: asNonEmptyString(project["name"]) ?? projectId,
    repo: asNonEmptyString(project["repo"]) ?? `local-${projectId}`,
    path: projectPath,
    agent: asNonEmptyString(project["agent"]) ?? "claude-code",
    defaultBranch: asNonEmptyString(project["defaultBranch"]) ?? "main",
    defaultWorkingDirectory: asNonEmptyString(project["defaultWorkingDirectory"]),
    sessionPrefix: asNonEmptyString(project["sessionPrefix"]),
    workspace: asNonEmptyString(project["workspace"]),
    runtime: asNonEmptyString(project["runtime"]),
    scm: asNonEmptyString(project["scm"]),
    boardDir: asNonEmptyString(project["boardDir"]),
    agentModel: asNonEmptyString(agentConfig["model"]),
    agentPermissions: agentConfig["permissions"] === "default" ? "default" : "skip",
  };
}

export async function normalizeRootProjectPaths(rootConfig: MutableConfig): Promise<void> {
  const projects = toObject(rootConfig["projects"]);

  for (const [projectId, rawProject] of Object.entries(projects)) {
    const project = toObject(rawProject);
    const rawProjectPath = asNonEmptyString(project["path"]);
    if (!rawProjectPath) {
      continue;
    }

    const resolvedProjectPath = resolveConfiguredProjectPath(
      rawProjectPath,
      asNonEmptyString(project["repo"]),
    );

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
  const projects = toObject(rootConfig["projects"]);
  const project = toObject(projects[projectId]);
  const rawProjectPath = asNonEmptyString(project["path"]);
  if (!rawProjectPath) {
    return;
  }
  const projectPath = resolveConfiguredProjectPath(rawProjectPath, asNonEmptyString(project["repo"]));
  if (!await isDirectory(projectPath)) {
    return;
  }

  const yaml = buildConductorYaml({
    port: typeof rootConfig["port"] === "number" ? rootConfig["port"] : 4747,
    dashboardUrl: asNonEmptyString(rootConfig["dashboardUrl"]),
    preferences: normalizePreferences(rootConfig["preferences"]),
    projects: [buildProjectScaffold(projectId, project, projectPath)],
  });
  await writeFile(join(projectPath, "conductor.yaml"), yaml, "utf8");
}

export async function syncAllProjectLocalConfigs(rootConfig: MutableConfig): Promise<void> {
  await normalizeRootProjectPaths(rootConfig);
  const projects = toObject(rootConfig["projects"]);
  for (const projectId of Object.keys(projects)) {
    await syncProjectLocalConfig(rootConfig, projectId);
  }
}
