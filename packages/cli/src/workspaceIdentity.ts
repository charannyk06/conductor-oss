import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function normalizeWorkspaceIdentityPath(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

export function resolveWorkspaceConfigPath(workspaceOrConfigPath: string): string {
  const candidate = resolve(expandHome(workspaceOrConfigPath));
  return basename(candidate) === "conductor.yaml"
    ? candidate
    : join(candidate, "conductor.yaml");
}

export function workspaceIdForPath(workspaceOrConfigPath: string): string {
  const configPath = realpathSync(resolveWorkspaceConfigPath(workspaceOrConfigPath));
  return workspaceIdForDirectory(dirname(configPath));
}

export function workspaceIdForDirectory(workspacePath: string): string {
  return createHash("sha256")
    .update(normalizeWorkspaceIdentityPath(realpathSync(resolve(expandHome(workspacePath)))))
    .digest("hex")
    .slice(0, 12);
}
