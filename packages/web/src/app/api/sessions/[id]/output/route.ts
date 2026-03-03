import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { type NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

/** Capture tmux pane output directly. Bypasses plugin registry since web runs on the same host. */
async function captureTmuxOutput(tmuxName: string, lines: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "capture-pane",
      "-t", tmuxName,
      "-p",
      "-S", `-${lines}`,
    ], { timeout: 5000 });
    return stdout;
  } catch {
    return "";
  }
}

/** Parse a simple key=value metadata file into a record. */
function parseMetadata(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return result;
}

function safeReadMetadata(filePath: string): Record<string, string> | null {
  try {
    return parseMetadata(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function safeEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Resolve tmux session name by scanning conductor metadata (active + archived). */
function resolveTmuxName(sessionId: string): string | null {
  const conductorDir = join(homedir(), ".conductor");
  if (!existsSync(conductorDir)) return null;

  for (const projectDir of safeEntries(conductorDir)) {
    const sessionsDir = join(conductorDir, projectDir, "sessions");
    if (!existsSync(sessionsDir)) continue;
    try {
      if (!statSync(sessionsDir).isDirectory()) continue;
    } catch {
      continue;
    }

    // Check active session
    const activeFile = join(sessionsDir, sessionId);
    if (existsSync(activeFile)) {
      const meta = safeReadMetadata(activeFile);
      if (!meta) continue;
      if (meta["tmuxName"]) return meta["tmuxName"];
      if (meta["runtimeHandle"]) {
        try {
          const handle = JSON.parse(meta["runtimeHandle"]) as { id?: string };
          if (handle.id) return handle.id;
        } catch { /* ignore */ }
      }
    }

    // Check archive — files named like cip-1_2026-02-28T...
    const archiveDir = join(sessionsDir, "archive");
    if (!existsSync(archiveDir)) continue;
    const archiveFiles = safeEntries(archiveDir)
      .filter((f) => f.startsWith(sessionId + "_"))
      .sort()
      .reverse(); // Most recent first

    for (const archiveFile of archiveFiles) {
      const meta = safeReadMetadata(join(archiveDir, archiveFile));
      if (!meta) continue;
      if (meta["tmuxName"]) return meta["tmuxName"];
      if (meta["runtimeHandle"]) {
        try {
          const handle = JSON.parse(meta["runtimeHandle"]) as { id?: string };
          if (handle.id) return handle.id;
        } catch { /* ignore */ }
      }
    }
  }

  return null;
}

/** GET /api/sessions/:id/output -- Capture terminal output from the session's tmux pane. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;
  const { id } = await params;

  if (!id || id.trim().length === 0) {
    return NextResponse.json({ error: "Session ID is required" }, { status: 400 });
  }
  if (!VALID_SESSION_ID.test(id)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const url = new URL(request.url);
  const rawLines = parseInt(url.searchParams.get("lines") ?? "500", 10);
  const lines = Number.isFinite(rawLines) ? Math.min(1000, Math.max(1, rawLines)) : 500;

  const tmuxName = resolveTmuxName(id);
  if (!tmuxName) {
    return NextResponse.json({ error: "Session not found or no tmux session" }, { status: 404 });
  }

  const output = await captureTmuxOutput(tmuxName, lines);
  return NextResponse.json({ sessionId: id, output, lines });
}

/** POST /api/sessions/:id/output -- Stream terminal output via Server-Sent Events. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const { id } = await params;

  if (!id || id.trim().length === 0) {
    return NextResponse.json({ error: "Session ID is required" }, { status: 400 });
  }
  if (!VALID_SESSION_ID.test(id)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const stream = body?.stream === true;

  if (!stream) {
    return NextResponse.json({ error: "Use GET for single capture or POST with {stream:true} for SSE" }, { status: 400 });
  }

  const tmuxName = resolveTmuxName(id);
  if (!tmuxName) {
    return NextResponse.json({ error: "Session not found or no tmux session" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let aborted = false;

  const readable = new ReadableStream({
    async start(controller) {
      let lastHash = "";

      const send = (data: string): void => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          aborted = true;
        }
      };

      const tick = async (): Promise<void> => {
        if (aborted) return;
        try {
          const output = await captureTmuxOutput(tmuxName, 500);
          const hash = `${output.length}:${output.slice(-200)}`;
          if (hash !== lastHash) {
            lastHash = hash;
            send(JSON.stringify({ type: "output", sessionId: id, output }));
          }
        } catch {
          send(JSON.stringify({ type: "error", message: "Session terminated" }));
          aborted = true;
          controller.close();
        }
      };

      await tick();

      const interval = setInterval(() => {
        void tick();
      }, 1000);

      const heartbeat = setInterval(() => {
        if (!aborted) {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            aborted = true;
          }
        }
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        aborted = true;
        clearInterval(interval);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
