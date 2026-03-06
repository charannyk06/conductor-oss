import { NextResponse } from "next/server";
import { existsSync, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { OrchestratorConfig } from "@conductor-oss/core";
import { guardApiAccess } from "@/lib/auth";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const MAX_FILES = 300;
const MAX_DEPTH = 4;

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff",
]);

const CONTEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rtf", ".csv", ".tsv",
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".css", ".scss", ".html", ".sql", ".sh", ".bash", ".zsh",
  ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff",
]);

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

function resolveWorkspacePath(config: OrchestratorConfig): string {
  if (process.env["CONDUCTOR_WORKSPACE"]?.trim()) {
    return expandHome(process.env["CONDUCTOR_WORKSPACE"]);
  }
  if (config.configPath) {
    return dirname(config.configPath);
  }
  return resolve(process.cwd());
}

function lastPathSegment(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  if (index < 0) return "";
  return path.slice(index).toLowerCase();
}

function isAllowedContextFile(path: string): boolean {
  const ext = extensionOf(path);
  return CONTEXT_EXTENSIONS.has(ext);
}

function isImageFile(path: string): boolean {
  const ext = extensionOf(path);
  return IMAGE_EXTENSIONS.has(ext);
}

function toWorkspaceRelative(workspaceRoot: string, path: string): string | null {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = resolve(path);
  const workspacePrefix = resolvedWorkspace.endsWith(sep)
    ? resolvedWorkspace
    : `${resolvedWorkspace}${sep}`;
  if (resolvedPath !== resolvedWorkspace && !resolvedPath.startsWith(workspacePrefix)) {
    return null;
  }
  return resolvedPath.slice(resolvedWorkspace.length).replace(/^[/\\]+/, "").replaceAll("\\", "/");
}

type ContextFileEntry = {
  path: string;
  name: string;
  kind: "image" | "file";
  source: string;
  sizeBytes: number | null;
};

async function collectContextFiles(params: {
  workspaceRoot: string;
  rootPath: string;
  source: string;
  seen: Set<string>;
  files: ContextFileEntry[];
}): Promise<void> {
  if (!existsSync(params.rootPath)) return;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: params.rootPath, depth: 0 }];

  while (queue.length > 0 && params.files.length < MAX_FILES) {
    const current = queue.shift();
    if (!current) break;

    let entries: Dirent[];
    try {
      entries = await readdir(current.dir, { withFileTypes: true, encoding: "utf8" }) as Dirent[];
    } catch {
      continue;
    }

    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const entry of entries) {
      if (params.files.length >= MAX_FILES) break;
      const entryName = String(entry.name);
      if (entryName.startsWith(".")) continue;
      const fullPath = join(current.dir, entryName);

      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const relativePath = toWorkspaceRelative(params.workspaceRoot, fullPath);
      if (!relativePath) continue;
      if (!isAllowedContextFile(relativePath)) continue;
      if (params.seen.has(relativePath)) continue;

      params.seen.add(relativePath);
      const fileStat = await stat(fullPath).catch(() => null);
      params.files.push({
        path: relativePath,
        name: entryName,
        kind: isImageFile(relativePath) ? "image" : "file",
        source: params.source,
        sizeBytes: fileStat?.size ?? null,
      });
    }
  }
}

/** GET /api/context-files?projectId=<id> -- List likely context/attachment files for task composer. */
export async function GET(request: Request) {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  try {
    const { config } = await getServices();
    const workspaceRoot = resolveWorkspacePath(config);
    const url = new URL(request.url);
    const projectId = asNonEmptyString(url.searchParams.get("projectId"));

    if (projectId && !config.projects[projectId]) {
      return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
    }

    const roots: Array<{ path: string; source: string }> = [
      { path: resolve(workspaceRoot, "attachments"), source: "workspace/attachments" },
      { path: resolve(workspaceRoot, "context"), source: "workspace/context" },
    ];

    if (projectId) {
      const project = config.projects[projectId];
      const boardDir = lastPathSegment(project.boardDir ?? projectId) || projectId;
      roots.push({ path: resolve(workspaceRoot, "projects", boardDir, "attachments"), source: `projects/${boardDir}/attachments` });
      roots.push({ path: resolve(workspaceRoot, "projects", boardDir, "context"), source: `projects/${boardDir}/context` });
      roots.push({ path: resolve(workspaceRoot, boardDir, "attachments"), source: `${boardDir}/attachments` });
      roots.push({ path: resolve(workspaceRoot, boardDir, "context"), source: `${boardDir}/context` });
    }

    const files: ContextFileEntry[] = [];
    const seen = new Set<string>();

    for (const root of roots) {
      await collectContextFiles({
        workspaceRoot,
        rootPath: root.path,
        source: root.source,
        seen,
        files,
      });
      if (files.length >= MAX_FILES) break;
    }

    return NextResponse.json({
      workspacePath: workspaceRoot,
      files,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list context files" },
      { status: 500 },
    );
  }
}
