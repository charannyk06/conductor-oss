/**
 * workspace-worktree plugin — git worktrees for code isolation.
 *
 * - create: git worktree add
 * - destroy: git worktree remove
 * - postCreate: run symlinks + postCreate commands from project config
 * - exists: check if path exists and is valid git worktree
 * - restore: recreate worktree from existing branch
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  existsSync,
  lstatSync,
  symlinkSync,
  rmSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  cpSync,
} from "node:fs";
import { join, resolve, basename, dirname, extname, relative } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@conductor-oss/core";

/** Timeout for git commands (30 seconds) */
const GIT_TIMEOUT = 30_000;

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "worktree",
  slot: "workspace" as const,
  description: "Workspace plugin: git worktrees",
  version: "0.1.0",
};

/** Run a git command in a given directory */
const GIT_LOCK_RETRY_DELAYS_MS = [300, 700, 1500, 3000, 5000];
const REPO_LOCK_TIMEOUT_MS = 30_000;
const REPO_LOCK_RETRY_MS = 200;

function isGitLockError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("could not lock config file")
    || normalized.includes("index.lock")
    || normalized.includes("unable to create '.git")
    || normalized.includes("another git process seems to be running");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= GIT_LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT });
      return stdout.trimEnd();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isGitLockError(message) || attempt >= GIT_LOCK_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await sleep(GIT_LOCK_RETRY_DELAYS_MS[attempt] ?? 250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function withRepoLock<T>(repoPath: string, action: () => Promise<T>): Promise<T> {
  const lockDir = join(repoPath, ".git", "conductor-worktree.lock");
  const deadline = Date.now() + REPO_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for repository lock at ${lockDir}`);
      }
      await sleep(REPO_LOCK_RETRY_MS);
    }
  }

  try {
    return await action();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Only allow safe characters in path segments to prevent directory traversal */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} "${value}": must match ${SAFE_PATH_SEGMENT}`);
  }
}

/** Expand ~ to home directory */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function uniqueCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of candidates) {
    const resolved = resolve(expandPath(raw));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    ordered.push(resolved);
  }
  return ordered;
}

function extractRepoName(repoValue?: string | null): string | null {
  if (!repoValue || repoValue.trim().length === 0) return null;
  const raw = repoValue.trim();
  const withoutGit = raw.replace(/\.git$/i, "");
  const parts = withoutGit.split(/[/:]/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : null;
}

async function isGitRepository(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    await git(path, "rev-parse", "--is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}

async function maybeResolveCaseInsensitive(path: string): Promise<string | null> {
  const parent = dirname(path);
  const target = basename(path).toLowerCase();
  if (!existsSync(parent)) return null;

  try {
    const entries = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));

    for (const entryPath of entries) {
      if (basename(entryPath).toLowerCase() !== target) continue;
      if (await isGitRepository(entryPath)) return entryPath;
    }
  } catch {
    // Best effort only.
  }
  return null;
}

async function resolveRepoPath(projectPath: string, repoValue?: string | null): Promise<string> {
  const expandedProjectPath = expandPath(projectPath);
  const projectPathExt = extname(expandedProjectPath).toLowerCase();
  const repoName = extractRepoName(repoValue);

  const baseCandidates = [
    expandedProjectPath,
    ...(projectPathExt ? [dirname(expandedProjectPath)] : []),
    ...(repoName ? [join(dirname(expandedProjectPath), repoName)] : []),
    ...(repoName ? [join(homedir(), ".openclaw", "projects", repoName)] : []),
    ...(repoName ? [join(homedir(), ".conductor", "projects", repoName)] : []),
    ...(repoName ? [join(homedir(), ".worktrees", repoName)] : []),
    expandedProjectPath.replace("/workspace/projects/", "/projects/"),
    ...(repoName
      ? [join(homedir(), ".openclaw", "projects", repoName.toLowerCase())]
      : []),
  ];

  const candidates = uniqueCandidates(baseCandidates);
  for (const candidate of candidates) {
    if (await isGitRepository(candidate)) return candidate;
    const caseInsensitiveMatch = await maybeResolveCaseInsensitive(candidate);
    if (caseInsensitiveMatch) return caseInsensitiveMatch;
  }

  const candidateSummary = candidates.map((path) => `  - ${path}`).join("\n");
  const repoHint = repoName ? ` (repo: ${repoName})` : "";
  throw new Error(
    `Project path is not a git repository${repoHint}.\n` +
      `Configured path: ${expandedProjectPath}\n` +
      `Checked candidates:\n${candidateSummary}\n` +
      `Update project.path to your local git repo root or re-add the workspace from Git Repository mode.`,
  );
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+/g, "/");
}

function assertSafeRelativePath(path: string, label: string): string {
  const normalized = normalizeRelativePath(path).trim();
  if (!normalized || normalized === ".") {
    throw new Error(`Invalid ${label}: value cannot be empty`);
  }
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(`Invalid ${label} "${path}": must be relative and stay within the repository`);
  }
  return normalized;
}

function globPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__GLOBSTAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function collectRepoFiles(repoPath: string): string[] {
  const out: string[] = [];
  const stack = [repoPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const rel = normalizeRelativePath(relative(repoPath, current));
    if (rel === ".git" || rel.startsWith(".git/")) continue;

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const next = join(current, entry.name);
      const relPath = normalizeRelativePath(relative(repoPath, next));
      if (relPath === ".git" || relPath.startsWith(".git/")) continue;
      if (entry.isDirectory()) {
        stack.push(next);
        continue;
      }
      out.push(relPath);
    }
  }

  return out;
}

function resolveCopyFileMatches(repoPath: string, patterns: string[]): string[] {
  const allFiles = collectRepoFiles(repoPath);
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const rawPattern of patterns) {
    const pattern = assertSafeRelativePath(rawPattern, "copyFiles pattern");
    const hasGlob = /[*?]/.test(pattern);
    if (!hasGlob) {
      const source = resolve(repoPath, pattern);
      if (!existsSync(source)) continue;
      const rel = normalizeRelativePath(relative(repoPath, source));
      if (seen.has(rel)) continue;
      seen.add(rel);
      matches.push(rel);
      continue;
    }

    const regex = globPatternToRegex(pattern);
    for (const file of allFiles) {
      if (!regex.test(file)) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      matches.push(file);
    }
  }

  return matches;
}

function copyConfiguredFiles(repoPath: string, worktreePath: string, patterns?: string[]): void {
  if (!patterns || patterns.length === 0) return;
  const matches = resolveCopyFileMatches(repoPath, patterns);
  for (const rel of matches) {
    const source = resolve(repoPath, rel);
    const target = resolve(worktreePath, rel);
    if (!target.startsWith(`${worktreePath}/`) && target !== worktreePath) {
      throw new Error(`copyFiles target "${rel}" resolves outside workspace`);
    }

    const sourceStat = statSync(source, { throwIfNoEntry: false });
    if (!sourceStat) continue;
    mkdirSync(dirname(target), { recursive: true });
    if (sourceStat.isDirectory()) {
      cpSync(source, target, { recursive: true });
    } else {
      copyFileSync(source, target);
    }
  }
}

export function create(config?: Record<string, unknown>): Workspace {
  const worktreeBaseDir = config?.worktreeDir
    ? expandPath(config.worktreeDir as string)
    : join(homedir(), ".worktrees");

  return {
    name: "worktree",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = await resolveRepoPath(cfg.project.path, cfg.project.repo);
      const projectWorktreeDir = join(worktreeBaseDir, cfg.projectId);
      const worktreePath = join(projectWorktreeDir, cfg.sessionId);

      mkdirSync(projectWorktreeDir, { recursive: true });

      await withRepoLock(repoPath, async () => {
        // Fetch latest from remote
        try {
          await git(repoPath, "fetch", "origin", "--quiet");
        } catch {
          // Fetch may fail if offline — continue anyway
        }

        const baseBranch = (cfg as WorkspaceCreateConfig & { baseBranch?: string }).baseBranch;
        const requestedBranch = baseBranch?.trim() || cfg.project.defaultBranch;
        const candidates = [
          `origin/${requestedBranch}`,
          requestedBranch,
          `origin/${cfg.project.defaultBranch}`,
          cfg.project.defaultBranch,
        ];

        let baseRef = "HEAD";
        for (const candidate of candidates) {
          try {
            await git(repoPath, "rev-parse", "--verify", candidate);
            baseRef = candidate;
            break;
          } catch {
            // Try the next candidate.
          }
        }

        // Create worktree with a new branch
        try {
          await git(repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("already exists")) {
            throw new Error(
              `Failed to create worktree for branch "${cfg.branch}" from repo "${repoPath}": ${msg}`,
              {
                cause: err,
              },
            );
          }
          // Branch already exists — create worktree and check it out
          await git(repoPath, "worktree", "add", worktreePath, baseRef);
          try {
            await git(worktreePath, "checkout", cfg.branch);
          } catch (checkoutErr: unknown) {
            try {
              await git(repoPath, "worktree", "remove", "--force", worktreePath);
            } catch {
              // Best-effort cleanup
            }
            const checkoutMsg =
              checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
            throw new Error(`Failed to checkout branch "${cfg.branch}" in worktree: ${checkoutMsg}`, {
              cause: checkoutErr,
            });
          }
        }
      });

      return {
        path: worktreePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      let repoPath: string | null = null;
      let branchName: string | null = null;

      // 1. Resolve the main repo path and current branch before removing
      try {
        const gitCommonDir = await git(
          workspacePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        repoPath = resolve(gitCommonDir, "..");
      } catch {
        // Worktree may already be broken — try to infer repo from parent structure
        // Worktrees live at ~/.worktrees/{projectId}/{sessionId}
        // Repos may live at ~/.conductor/projects/{projectId}
        const sessionId = basename(workspacePath);
        const projectId = basename(dirname(workspacePath));
        const inferredRepo = join(homedir(), ".conductor", "projects", projectId);
        if (existsSync(join(inferredRepo, ".git"))) {
          repoPath = inferredRepo;
        }
        // branchName can be inferred from session naming convention
        if (sessionId) {
          branchName = `session/${sessionId}`;
        }
      }

      // 2. Get branch name from worktree if we haven't inferred it
      if (!branchName && existsSync(workspacePath)) {
        try {
          const ref = await git(workspacePath, "rev-parse", "--abbrev-ref", "HEAD");
          if (ref && ref !== "HEAD") {
            branchName = ref;
          }
        } catch {
          // Worktree might be broken
        }
      }

      // 3. Remove the worktree via git
      if (repoPath) {
        await withRepoLock(repoPath, async () => {
          try {
            await git(repoPath, "worktree", "remove", "--force", workspacePath);
          } catch {
            // Force-remove the directory if git worktree remove fails
            if (existsSync(workspacePath)) {
              rmSync(workspacePath, { recursive: true, force: true });
            }
          }

          // 4. Prune stale worktree references
          try {
            await git(repoPath, "worktree", "prune");
          } catch {
            // Best effort
          }

          // 5. Delete the session branch
          if (branchName && branchName.startsWith("session/")) {
            try {
              await git(repoPath, "branch", "-D", branchName);
            } catch {
              // Branch may already be gone or not exist
            }
          }
        });

        // 6. Clean up empty parent directory (e.g. ~/.worktrees/projectId/)
        const parentDir = dirname(workspacePath);
        if (existsSync(parentDir)) {
          try {
            const remaining = readdirSync(parentDir);
            if (remaining.length === 0) {
              rmSync(parentDir, { force: true });
            }
          } catch {
            // Best effort
          }
        }
      } else {
        // No repo found — just nuke the directory
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectWorktreeDir = join(worktreeBaseDir, projectId);
      if (!existsSync(projectWorktreeDir)) return [];

      const entries = readdirSync(projectWorktreeDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(projectWorktreeDir, e.name));

      if (dirs.length === 0) return [];

      // Use first valid worktree to get the list
      let worktreeListOutput = "";
      for (const dir of dirs) {
        try {
          worktreeListOutput = await git(dir, "worktree", "list", "--porcelain");
          break;
        } catch {
          continue;
        }
      }

      if (!worktreeListOutput) return [];

      const infos: WorkspaceInfo[] = [];
      const blocks = worktreeListOutput.split("\n\n");

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        let path = "";
        let branch = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            path = line.slice("worktree ".length);
          } else if (line.startsWith("branch ")) {
            branch = line.slice("branch ".length).replace("refs/heads/", "");
          }
        }

        if (path && (path === projectWorktreeDir || path.startsWith(projectWorktreeDir + "/"))) {
          const sessionId = basename(path);
          infos.push({
            path,
            branch: branch || "detached",
            sessionId,
            projectId,
          });
        }
      }

      return infos;
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: GIT_TIMEOUT,
        });
        return true;
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      const repoPath = await resolveRepoPath(cfg.project.path, cfg.project.repo);

      await withRepoLock(repoPath, async () => {
        // Prune stale worktree entries
        try {
          await git(repoPath, "worktree", "prune");
        } catch {
          // Best effort
        }

        // Fetch latest
        try {
          await git(repoPath, "fetch", "origin", "--quiet");
        } catch {
          // May fail if offline
        }

        // Try to create worktree on the existing branch
        try {
          await git(repoPath, "worktree", "add", workspacePath, cfg.branch);
        } catch {
          const remoteBranch = `origin/${cfg.branch}`;
          try {
            await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, remoteBranch);
          } catch {
            const baseRef = `origin/${cfg.project.defaultBranch}`;
            await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, baseRef);
          }
        }
      });

      return {
        path: workspacePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      const repoPath = await resolveRepoPath(project.path, project.repo);

      // Copy configured repo files into the worktree (e.g. .env, config/*.json)
      if (project.copyFiles && project.copyFiles.length > 0) {
        copyConfiguredFiles(repoPath, info.path, project.copyFiles);
      }

      // Symlink shared resources
      if (project.symlinks) {
        for (const symlinkPath of project.symlinks) {
          // Guard against absolute paths and directory traversal
          if (symlinkPath.startsWith("/") || symlinkPath.includes("..")) {
            throw new Error(
              `Invalid symlink path "${symlinkPath}": must be a relative path without ".." segments`,
            );
          }

          const sourcePath = join(repoPath, symlinkPath);
          const targetPath = resolve(info.path, symlinkPath);

          // Verify resolved target is still within the workspace
          if (!targetPath.startsWith(info.path + "/") && targetPath !== info.path) {
            throw new Error(
              `Symlink target "${symlinkPath}" resolves outside workspace: ${targetPath}`,
            );
          }

          if (!existsSync(sourcePath)) continue;

          // Remove existing target if it exists
          try {
            const targetStat = lstatSync(targetPath);
            if (targetStat.isSymbolicLink() || targetStat.isFile() || targetStat.isDirectory()) {
              rmSync(targetPath, { recursive: true, force: true });
            }
          } catch {
            // Target doesn't exist — that's fine
          }

          // Ensure parent directory exists for nested symlink targets
          mkdirSync(dirname(targetPath), { recursive: true });
          symlinkSync(sourcePath, targetPath);
        }
      }

      // Run setup hooks. New setupScript takes precedence; legacy postCreate remains supported.
      const setupCommands = project.setupScript && project.setupScript.length > 0
        ? project.setupScript
        : project.postCreate;
      if (!setupCommands || setupCommands.length === 0) return;

      if (project.runSetupInParallel) {
        for (const command of setupCommands) {
          const script = command.trim();
          if (!script) continue;
          void execFileAsync("sh", ["-c", script], { cwd: info.path, timeout: 900_000 }).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[workspace-worktree] setup command failed: ${message}`);
          });
        }
        return;
      }

      for (const command of setupCommands) {
        const script = command.trim();
        if (!script) continue;
        await execFileAsync("sh", ["-c", script], { cwd: info.path, timeout: 900_000 });
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
