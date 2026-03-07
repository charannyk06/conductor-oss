/**
 * Config Sync -- detects and repairs drift between workspace canonical
 * config and project-local generated conductor.yaml mirrors.
 *
 * The workspace conductor.yaml is the single source of truth.
 * Project-local files are generated mirrors used by agents and MCP.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildConductorYaml,
  GENERATED_MARKER_KEY,
  type ConductorYamlScaffoldConfig,
  type ScaffoldProjectConfig,
} from "./scaffold.js";
import type { OrchestratorConfig, ProjectConfig } from "./types.js";
import { getDefaultModelAccessPreferences } from "./types.js";
import { generateSessionPrefix } from "./paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigDriftReport {
  projectId: string;
  projectPath: string;
  localConfigPath: string;
  status: "ok" | "missing" | "drifted" | "unmanaged";
  /** Human-readable description of the drift. */
  reason?: string;
  /** Fields that differ between canonical and local. */
  driftedFields?: string[];
}

export interface ConfigSyncResult {
  reports: ConfigDriftReport[];
  /** Number of project-local configs that were regenerated. */
  fixed: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function buildProjectScaffoldFromConfig(
  projectId: string,
  project: ProjectConfig,
): ScaffoldProjectConfig {
  return {
    projectId,
    displayName: project.name ?? projectId,
    repo: project.repo,
    path: project.path,
    agent: project.agent ?? "claude-code",
    defaultBranch: project.defaultBranch ?? "main",
    defaultWorkingDirectory: project.defaultWorkingDirectory ?? null,
    sessionPrefix: project.sessionPrefix ?? generateSessionPrefix(basename(project.path)),
    workspace: project.workspace ?? null,
    runtime: project.runtime ?? null,
    scm: project.scm?.plugin ?? null,
    boardDir: project.boardDir ?? null,
    agentModel: project.agentConfig?.model ?? null,
    agentReasoningEffort: project.agentConfig?.reasoningEffort ?? null,
    agentPermissions: project.agentConfig?.permissions ?? "skip",
  };
}

function buildExpectedYaml(
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
): string {
  const preferences = config.preferences ?? {};
  const scaffoldConfig: ConductorYamlScaffoldConfig = {
    port: config.port ?? 4747,
    dashboardUrl: asNonEmptyString(config.dashboardUrl as unknown as string),
    preferences: {
      onboardingAcknowledged: preferences.onboardingAcknowledged,
      codingAgent: preferences.codingAgent,
      ide: preferences.ide,
      remoteSshHost: preferences.remoteSshHost,
      remoteSshUser: preferences.remoteSshUser,
      markdownEditor: preferences.markdownEditor,
      modelAccess: preferences.modelAccess ?? getDefaultModelAccessPreferences(),
      notifications: preferences.notifications,
    },
    projects: [buildProjectScaffoldFromConfig(projectId, project)],
  };

  return buildConductorYaml(scaffoldConfig);
}

/**
 * Compare two YAML strings ignoring the _generatedFromWorkspace timestamp.
 * Returns the list of top-level keys that differ, or empty if equivalent.
 */
function diffYaml(expected: string, actual: string): string[] {
  let expectedObj: Record<string, unknown>;
  let actualObj: Record<string, unknown>;

  try {
    expectedObj = toObject(parseYaml(expected));
    actualObj = toObject(parseYaml(actual));
  } catch {
    return ["parse_error"];
  }

  // Remove the generation marker from both for comparison
  delete expectedObj[GENERATED_MARKER_KEY];
  delete actualObj[GENERATED_MARKER_KEY];

  const allKeys = new Set([...Object.keys(expectedObj), ...Object.keys(actualObj)]);
  const drifted: string[] = [];

  for (const key of allKeys) {
    const a = JSON.stringify(expectedObj[key] ?? null);
    const b = JSON.stringify(actualObj[key] ?? null);
    if (a !== b) {
      drifted.push(key);
    }
  }

  return drifted;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check all project-local conductor.yaml files for drift against the
 * workspace canonical config. Does not modify any files.
 */
export function detectConfigDrift(config: OrchestratorConfig): ConfigDriftReport[] {
  const reports: ConfigDriftReport[] = [];

  for (const [projectId, project] of Object.entries(config.projects)) {
    const localConfigPath = join(project.path, "conductor.yaml");

    if (!existsSync(project.path)) {
      reports.push({
        projectId,
        projectPath: project.path,
        localConfigPath,
        status: "missing",
        reason: "Project directory does not exist",
      });
      continue;
    }

    if (!existsSync(localConfigPath)) {
      reports.push({
        projectId,
        projectPath: project.path,
        localConfigPath,
        status: "missing",
        reason: "No project-local conductor.yaml",
      });
      continue;
    }

    const localContent = readFileSync(localConfigPath, "utf-8");
    let localObj: Record<string, unknown>;
    try {
      localObj = toObject(parseYaml(localContent));
    } catch {
      reports.push({
        projectId,
        projectPath: project.path,
        localConfigPath,
        status: "drifted",
        reason: "Project-local conductor.yaml is not valid YAML",
      });
      continue;
    }

    // Check if this file was generated by us
    if (!localObj[GENERATED_MARKER_KEY]) {
      reports.push({
        projectId,
        projectPath: project.path,
        localConfigPath,
        status: "unmanaged",
        reason: "Missing _generatedFromWorkspace marker; file may be hand-edited",
      });
      continue;
    }

    const expectedYaml = buildExpectedYaml(config, projectId, project);
    const driftedFields = diffYaml(expectedYaml, localContent);

    if (driftedFields.length === 0) {
      reports.push({
        projectId,
        projectPath: project.path,
        localConfigPath,
        status: "ok",
      });
    } else {
      reports.push({
        projectId,
        projectPath: project.path,
        localConfigPath,
        status: "drifted",
        reason: `Fields differ: ${driftedFields.join(", ")}`,
        driftedFields,
      });
    }
  }

  return reports;
}

/**
 * Regenerate all project-local conductor.yaml files from the workspace
 * canonical config. Overwrites existing files.
 */
export function syncAllProjectConfigs(config: OrchestratorConfig): ConfigSyncResult {
  const reports = detectConfigDrift(config);
  let fixed = 0;

  for (const report of reports) {
    if (report.status === "ok") continue;

    const project = config.projects[report.projectId];
    if (!project || !existsSync(project.path)) continue;

    const expectedYaml = buildExpectedYaml(config, report.projectId, project);
    writeFileSync(report.localConfigPath, expectedYaml, "utf-8");
    report.status = "ok";
    report.reason = "Regenerated from workspace canonical config";
    fixed++;
  }

  return { reports, fixed };
}

/**
 * Startup sync pass: regenerate project-local mirrors that are missing or drifted.
 * Only touches files that have the generation marker or are missing entirely.
 * Does not overwrite unmanaged files unless force=true.
 */
export function startupConfigSync(
  config: OrchestratorConfig,
  options?: { force?: boolean },
): ConfigSyncResult {
  const reports = detectConfigDrift(config);
  let fixed = 0;

  for (const report of reports) {
    if (report.status === "ok") continue;

    // Skip unmanaged files unless force is set
    if (report.status === "unmanaged" && !options?.force) continue;

    const project = config.projects[report.projectId];
    if (!project || !existsSync(project.path)) continue;

    const expectedYaml = buildExpectedYaml(config, report.projectId, project);
    writeFileSync(report.localConfigPath, expectedYaml, "utf-8");
    report.status = "ok";
    report.reason = "Synced from workspace canonical config";
    fixed++;
  }

  return { reports, fixed };
}
