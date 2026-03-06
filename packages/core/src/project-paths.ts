import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { expandHome } from "./paths.js";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function extractRepoTail(repoValue: string | null | undefined): string | null {
  if (typeof repoValue !== "string") return null;
  const trimmed = repoValue.trim();
  if (trimmed.length === 0) return null;

  const parts = trimmed
    .replace(/\.git$/i, "")
    .split(/[/:]/)
    .filter(Boolean);

  return parts[parts.length - 1] ?? null;
}

function uniqueCandidates(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const next: string[] = [];

  for (const value of values) {
    if (!value) continue;
    const resolved = resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    next.push(resolved);
  }

  return next;
}

export function resolveConfiguredProjectPath(
  projectPath: string,
  repoValue?: string | null,
): string {
  const expandedPath = resolve(expandHome(projectPath));
  if (isDirectory(expandedPath)) {
    return realpathSync.native(expandedPath);
  }

  const pathExt = extname(expandedPath);
  const pathStem = pathExt ? basename(expandedPath, pathExt) : basename(expandedPath);
  const repoTail = extractRepoTail(repoValue);
  const siblingDir = dirname(expandedPath);
  const workspaceProjectsDir = resolve(homedir(), ".openclaw", "workspace", "projects");
  const legacyProjectsDir = resolve(homedir(), ".openclaw", "projects");

  const candidates = uniqueCandidates([
    pathExt ? join(siblingDir, pathStem) : null,
    pathExt ? join(siblingDir, pathStem.toLowerCase()) : null,
    repoTail ? join(siblingDir, repoTail) : null,
    repoTail ? join(siblingDir, repoTail.toLowerCase()) : null,
    repoTail ? join(workspaceProjectsDir, repoTail) : null,
    repoTail ? join(workspaceProjectsDir, repoTail.toLowerCase()) : null,
    repoTail ? join(legacyProjectsDir, repoTail) : null,
    repoTail ? join(legacyProjectsDir, repoTail.toLowerCase()) : null,
  ]);

  for (const candidate of candidates) {
    if (existsSync(candidate) && isDirectory(candidate)) {
      return realpathSync.native(candidate);
    }
  }

  return expandedPath;
}
