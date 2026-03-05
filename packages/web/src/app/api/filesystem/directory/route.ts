import { NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
};

function resolveRequestedPath(rawPath: string | null): string {
  if (!rawPath || rawPath.trim().length === 0) {
    return homedir();
  }

  const trimmed = rawPath.trim();
  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }

  return resolve(trimmed);
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
  const denied = await guardApiAccess();
  if (denied) return denied;

  const rawPath = request.nextUrl.searchParams.get("path");
  const currentPath = resolveRequestedPath(rawPath);

  try {
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
