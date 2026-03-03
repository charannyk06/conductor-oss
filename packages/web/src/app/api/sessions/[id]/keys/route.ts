import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { type NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

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

/** Resolve tmux session name by scanning conductor metadata. */
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
  }

  return null;
}

/** Allowed special key names for tmux send-keys. */
const ALLOWED_SPECIAL_KEYS = new Set([
  "Enter", "Escape", "Tab", "BSpace", "DC", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Space",
  "C-c", "C-d", "C-u", "C-l", "C-a", "C-e", "C-k", "C-w", "C-z",
]);

/**
 * POST /api/sessions/:id/keys -- Send raw keys to the session's tmux pane.
 *
 * Body: { keys: string }
 *   - For text: sends literal characters via tmux send-keys -l
 *   - For special keys: use names like "Enter", "C-c", "Escape"
 *
 * Body: { special: string }
 *   - Sends a tmux special key (Enter, C-c, Escape, etc.)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
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
  if (!body) {
    return NextResponse.json({ error: "Request body required" }, { status: 400 });
  }

  const tmuxName = resolveTmuxName(id);
  if (!tmuxName) {
    return NextResponse.json({ error: "Session not found or no tmux session" }, { status: 404 });
  }

  try {
    if (typeof body.special === "string") {
      // Send a special key (Enter, C-c, Escape, etc.)
      const key = body.special;
      if (!ALLOWED_SPECIAL_KEYS.has(key)) {
        return NextResponse.json({ error: `Invalid special key: ${key}` }, { status: 400 });
      }
      await execFileAsync("tmux", ["send-keys", "-t", tmuxName, key], { timeout: 5000 });
    } else if (typeof body.keys === "string") {
      // Send literal text characters
      const keys = body.keys;
      if (keys.length > 5000) {
        return NextResponse.json({ error: "Keys too long (max 5000)" }, { status: 400 });
      }
      await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "-l", keys], { timeout: 5000 });
    } else {
      return NextResponse.json({ error: "keys (string) or special (string) is required" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, sessionId: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send keys";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
