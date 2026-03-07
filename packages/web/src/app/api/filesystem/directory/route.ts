import { NextRequest, NextResponse } from "next/server";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

const HOME_ROOT = homedir();
const VOLUMES_ROOT = "/Volumes";
const SAFE_SEGMENT_PATTERN = /^[^/\\\0\r\n]+$/;

type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
};

class InputError extends Error {}

function ensureWithinRoot(root: string, candidatePath: string) {
  const rel = relative(root, candidatePath);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new InputError("Path is outside the allowed browse roots");
  }
}

function resolveRootSelection(rawPath: string | null): { root: string; relativePath: string } {
  if (!rawPath || rawPath.trim().length === 0) {
    return { root: HOME_ROOT, relativePath: "" };
  }

  const trimmed = rawPath.trim();
  if (/[\0\r\n]/.test(trimmed)) {
    throw new InputError("Invalid path");
  }

  if (trimmed === "~" || trimmed === HOME_ROOT) {
    return { root: HOME_ROOT, relativePath: "" };
  }

  if (trimmed.startsWith("~/")) {
    return { root: HOME_ROOT, relativePath: trimmed.slice(2) };
  }

  if (trimmed.startsWith(`${HOME_ROOT}/`)) {
    return { root: HOME_ROOT, relativePath: trimmed.slice(HOME_ROOT.length + 1) };
  }

  if (trimmed === VOLUMES_ROOT) {
    return { root: VOLUMES_ROOT, relativePath: "" };
  }

  if (trimmed.startsWith(`${VOLUMES_ROOT}/`)) {
    return { root: VOLUMES_ROOT, relativePath: trimmed.slice(VOLUMES_ROOT.length + 1) };
  }

  throw new InputError("Path is outside the allowed browse roots");
}

function parseSafeSegments(relativePath: string): string[] {
  return relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (!SAFE_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..") {
        throw new InputError("Invalid path segment");
      }
      return segment;
    });
}

async function resolveRequestedPath(rawPath: string | null): Promise<string> {
  const { root, relativePath } = resolveRootSelection(rawPath);
  const canonicalRoot = await realpath(root);
  const segments = parseSafeSegments(relativePath);

  let currentPath = canonicalRoot;

  for (const segment of segments) {
    const candidatePath = resolve(currentPath, segment);
    const candidateStat = await stat(candidatePath);
    if (!candidateStat.isDirectory()) {
      throw new InputError("Path must be a directory");
    }

    const canonicalCandidate = await realpath(candidatePath);
    ensureWithinRoot(canonicalRoot, canonicalCandidate);
    currentPath = canonicalCandidate;
  }

  return currentPath;
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    const gitStat = await stat(resolve(path, ".git"));
    return gitStat.isDirectory();
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;

  const rawPath = request.nextUrl.searchParams.get("path");

  try {
    const currentPath = await resolveRequestedPath(rawPath);
    const dirEntries = await readdir(currentPath, { withFileTypes: true });

    const entries = await Promise.all(
      dirEntries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry): Promise<DirectoryEntry> => {
          const entryPath = resolve(currentPath, entry.name);
          return {
            name: entry.name,
            path: entryPath,
            isDirectory: true,
            isGitRepo: await isGitRepo(entryPath),
          };
        }),
    );

    entries.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    return NextResponse.json({
      currentPath,
      entries,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list directory";
    const status = err instanceof InputError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
