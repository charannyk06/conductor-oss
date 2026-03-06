import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { buildConductorYaml, type ScaffoldProjectConfig } from "@conductor-oss/core";

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

function buildProjectScaffold(projectId: string, project: Record<string, unknown>): ScaffoldProjectConfig {
  const agentConfig = toObject(project["agentConfig"]);

  return {
    projectId,
    displayName: asNonEmptyString(project["name"]) ?? projectId,
    repo: asNonEmptyString(project["repo"]) ?? `local-${projectId}`,
    path: expandHome(asNonEmptyString(project["path"]) ?? projectId),
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

export async function syncProjectLocalConfig(rootConfig: MutableConfig, projectId: string): Promise<void> {
  const projects = toObject(rootConfig["projects"]);
  const project = toObject(projects[projectId]);
  const projectPath = asNonEmptyString(project["path"]);
  if (!projectPath) {
    return;
  }

  const yaml = buildConductorYaml({
    port: typeof rootConfig["port"] === "number" ? rootConfig["port"] : 4747,
    dashboardUrl: asNonEmptyString(rootConfig["dashboardUrl"]),
    preferences: normalizePreferences(rootConfig["preferences"]),
    projects: [buildProjectScaffold(projectId, project)],
  });

  await writeFile(join(expandHome(projectPath), "conductor.yaml"), yaml, "utf8");
}

export async function syncAllProjectLocalConfigs(rootConfig: MutableConfig): Promise<void> {
  const projects = toObject(rootConfig["projects"]);
  for (const projectId of Object.keys(projects)) {
    await syncProjectLocalConfig(rootConfig, projectId);
  }
}
