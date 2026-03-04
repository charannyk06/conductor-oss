import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_FILE_COUNT = 4000;
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8000;
const IGNORE_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
]);

type FileListResponse = {
  workspacePath: string;
  files: string[];
  truncated: boolean;
};

type FileContentResponse = {
  workspacePath: string;
  path: string;
  content: string | null;
  size: number;
  binary: boolean;
  truncated: boolean;
};

function sanitizeSessionId(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return "";
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listWorkspaceFiles(root: string): FileListResponse {
  const files: string[] = [];
  let truncated = false;
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry === "." || entry === "..") continue;
      if (entry === ".git") continue;
      const absolute = resolve(current, entry);
      const relative = absolute.slice(root.length + 1).split(sep).join("/");

      if (isDir(absolute)) {
        if (!IGNORE_DIRS.has(entry)) {
          stack.push(absolute);
        }
        continue;
      }

      if (!isFile(absolute)) continue;
      files.push(relative);
      if (files.length >= MAX_FILE_COUNT) {
        truncated = true;
        return {
          workspacePath: root,
          files: files.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
          truncated,
        };
      }
    }
  }

  return {
    workspacePath: root,
    files: files.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
    truncated,
  };
}

function safeResolveFile(workspacePath: string, relativePath: string): string | null {
  const cleaned = relativePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/g, "")
    .replace(/\/+/g, "/");
  if (!cleaned || cleaned.startsWith("../") || cleaned.includes("/../")) return null;

  const resolvedFile = resolve(workspacePath, cleaned);
  const rootPrefix = workspacePath.endsWith(sep) ? workspacePath : `${workspacePath}${sep}`;
  if (resolvedFile !== workspacePath && !resolvedFile.startsWith(rootPrefix)) {
    return null;
  }
  return resolvedFile;
}

function loadFileContent(workspacePath: string, relativePath: string): FileContentResponse | null {
  const resolvedFile = safeResolveFile(workspacePath, relativePath);
  if (!resolvedFile || !existsSync(resolvedFile) || !isFile(resolvedFile)) return null;

  let raw: Buffer;
  try {
    raw = readFileSync(resolvedFile);
  } catch {
    return null;
  }

  const size = raw.byteLength;
  const sample = raw.subarray(0, Math.min(BINARY_SAMPLE_BYTES, raw.byteLength));
  const binary = sample.includes(0);
  const truncated = size > MAX_FILE_SIZE_BYTES;
  const content = binary
    ? null
    : raw.subarray(0, Math.min(size, MAX_FILE_SIZE_BYTES)).toString("utf8");

  return {
    workspacePath,
    path: relativePath,
    content,
    size,
    binary,
    truncated,
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<unknown> },
) {
  const denied = await guardApiAccess();
  if (denied) return denied;

  const params = await context.params as { id?: unknown } | null;
  const id = typeof params?.id === "string" ? params.id : "";
  const sessionId = sanitizeSessionId(id);
  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.get(sessionId);
    if (!session) {
      return NextResponse.json({ error: `Session ${sessionId} not found` }, { status: 404 });
    }

    const workspacePath = session.workspacePath ?? session.metadata["worktree"];
    if (!workspacePath || !isDir(workspacePath)) {
      return NextResponse.json({ error: "Session workspace is unavailable" }, { status: 404 });
    }

    const requestedPath = request.nextUrl.searchParams.get("path");
    if (requestedPath && requestedPath.trim().length > 0) {
      const filePayload = loadFileContent(workspacePath, requestedPath);
      if (!filePayload) {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
      }
      return NextResponse.json(filePayload);
    }

    return NextResponse.json(listWorkspaceFiles(workspacePath));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load workspace files";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
