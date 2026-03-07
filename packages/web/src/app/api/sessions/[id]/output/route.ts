import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

type SessionSnapshot = {
  filePath: string;
  values: Record<string, string>;
};

function parseMetadataFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

function tailText(content: string, lines: number): string {
  const chunks = content.split(/\r?\n/);
  return chunks.slice(-Math.max(lines, 1)).join("\n").trimEnd();
}

function resolveHomePath(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findSnapshotPaths(sessionId: string): string[] {
  const conductorRoot = resolve(homedir(), ".conductor");
  if (!existsSync(conductorRoot)) return [];

  const candidates: string[] = [];
  let roots: Dirent[];
  try {
    roots = readdirSync(conductorRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of roots) {
    if (!entry.isDirectory()) continue;
    const sessionsDir = join(conductorRoot, entry.name, "sessions");
    if (!existsSync(sessionsDir)) continue;

    const live = join(sessionsDir, sessionId);
    if (isReadableFile(live)) {
      candidates.push(live);
    }

    const archiveDir = join(sessionsDir, "archive");
    if (!existsSync(archiveDir)) continue;
    let archiveEntries: string[];
    try {
      archiveEntries = readdirSync(archiveDir);
    } catch {
      continue;
    }

    for (const fileName of archiveEntries) {
      if (fileName === sessionId || fileName.startsWith(`${sessionId}_`)) {
        const path = join(archiveDir, fileName);
        if (isReadableFile(path)) {
          candidates.push(path);
        }
      }
    }
  }

  return candidates.sort((left, right) => {
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function readLatestSessionSnapshot(sessionId: string): SessionSnapshot | null {
  for (const path of findSnapshotPaths(sessionId)) {
    try {
      const raw = readFileSync(path, "utf8");
      const values = parseMetadataFile(raw);
      return { filePath: path, values };
    } catch {
      continue;
    }
  }
  return null;
}

function buildFallbackLogCandidates(sessionId: string, snapshot: SessionSnapshot): string[] {
  const values = snapshot.values;
  const tmuxName = values["tmuxName"]?.trim();
  const worktree = values["worktree"]?.trim();

  const paths = new Set<string>();
  const addPath = (path: string | undefined): void => {
    if (!path) return;
    const trimmed = path.trim();
    if (!trimmed) return;
    paths.add(resolveHomePath(trimmed));
  };

  for (const key of [
    "sessionLog",
    "outputLog",
    "terminalLog",
    "transcript",
    "history",
    "historyFile",
    "devServerLog",
  ]) {
    addPath(values[key]);
  }

  if (worktree) {
    const normalizedWorktree = resolveHomePath(worktree);
    for (const id of [sessionId, tmuxName].filter(Boolean)) {
      addPath(join(normalizedWorktree, ".conductor", "logs", `${id}.log`));
      addPath(join(normalizedWorktree, ".conductor", "state", `${id}.log`));
    }
    addPath(join(normalizedWorktree, ".conductor", "session.log"));
    addPath(join(normalizedWorktree, ".codex", "history.jsonl"));
    addPath(join(normalizedWorktree, ".codex", "log", "codex-tui.log"));
    addPath(join(normalizedWorktree, ".claude", "logs", `${sessionId}.log`));
  }

  const snapshotDir = dirname(snapshot.filePath);
  addPath(join(snapshotDir, `${sessionId}.log`));
  if (tmuxName) {
    addPath(join(snapshotDir, `${tmuxName}.log`));
  }
  if (snapshotDir.endsWith(`${join("sessions", "archive")}`)) {
    const sessionsDir = dirname(snapshotDir);
    addPath(join(sessionsDir, sessionId));
    addPath(join(sessionsDir, `${sessionId}.log`));
    if (tmuxName) {
      addPath(join(sessionsDir, `${tmuxName}.log`));
    }
  }

  addPath(snapshot.filePath);

  return [...paths];
}

function readFallbackOutput(sessionId: string, lines: number): string | null {
  const snapshot = readLatestSessionSnapshot(sessionId);
  if (!snapshot) return null;

  const candidates = buildFallbackLogCandidates(sessionId, snapshot);
  const snapshotPath = resolve(snapshot.filePath);

  for (const candidatePath of candidates) {
    if (resolve(candidatePath) === snapshotPath) continue;
    if (!isReadableFile(candidatePath)) continue;
    try {
      const content = readFileSync(candidatePath, "utf8");
      if (!content.trim()) continue;
      return tailText(content, lines);
    } catch {
      continue;
    }
  }

  if (isReadableFile(snapshot.filePath)) {
    try {
      const content = readFileSync(snapshot.filePath, "utf8");
      if (content.trim()) {
        return tailText(content, lines);
      }
    } catch {
      // Ignore and use synthesized output.
    }
  }

  const status = snapshot.values["status"] ?? "unknown";
  const summary = snapshot.values["summary"] ?? "";
  const branch = snapshot.values["branch"] ?? "";
  const worktree = snapshot.values["worktree"] ?? "";
  const metadataDump = Object.entries(snapshot.values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const fallback = [
    `[session output fallback] Runtime output unavailable for ${sessionId}.`,
    `status=${status}`,
    branch ? `branch=${branch}` : "",
    worktree ? `worktree=${worktree}` : "",
    summary ? `summary=${summary}` : "",
    "",
    metadataDump,
  ].filter(Boolean).join("\n");

  return tailText(fallback, lines);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  const params = await context.params;
  const rawId = params?.id ?? "";
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawId).trim();
  } catch {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }
  if (!sessionId) {
    return NextResponse.json({ error: "Session id is required" }, { status: 400 });
  }

  const searchParams = new URL(request.url).searchParams;
  const rawLines = searchParams.get("lines");
  const parsedLines = rawLines ? Number.parseInt(rawLines, 10) : 500;
  const lines = Number.isFinite(parsedLines) && parsedLines > 0 ? Math.min(parsedLines, 5000) : 500;

  try {
    const { sessionManager } = await getServices();
    try {
      const output = await sessionManager.getOutput(sessionId, lines);
      return NextResponse.json({ output });
    } catch (runtimeErr) {
      const fallbackOutput = readFallbackOutput(sessionId, lines);
      if (fallbackOutput !== null) {
        return NextResponse.json({ output: fallbackOutput, source: "fallback-log" });
      }

      throw runtimeErr;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load output";
    const status = message.toLowerCase().includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
