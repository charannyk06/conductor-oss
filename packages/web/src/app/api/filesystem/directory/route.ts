import { NextRequest, NextResponse } from "next/server";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ALLOWED_DIRECTORY_ROOTS = [homedir(), "/Volumes"];

type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
};

class InputError extends Error {}

function isWithinAllowedRoots(path: string): boolean {
  return ALLOWED_DIRECTORY_ROOTS.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

async function resolveRequestedPath(rawPath: string | null): Promise<string> {
  let requestedPath = homedir();

  if (!rawPath || rawPath.trim().length === 0) {
    return requestedPath;
  }

  const trimmed = rawPath.trim();
  if (trimmed.startsWith("~/")) {
    requestedPath = resolve(homedir(), trimmed.slice(2));
  } else {
    requestedPath = resolve(trimmed);
  }

  if (!isWithinAllowedRoots(requestedPath)) {
    throw new InputError("Path is outside the allowed browse roots");
  }

  try {
    const canonicalPath = await realpath(requestedPath);
    if (!isWithinAllowedRoots(canonicalPath)) {
      throw new InputError("Path is outside the allowed browse roots");
    }
    return canonicalPath;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return requestedPath;
    }
    throw err;
  }
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
