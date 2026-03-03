import { type NextRequest, NextResponse } from "next/server";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const MAX_MESSAGE_LENGTH = 10_000;
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

/** Send a message to a tmux session (same approach as runtime-tmux plugin). */
async function sendToTmux(tmuxName: string, message: string): Promise<void> {
  // Clear any partial input
  await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "C-u"], { timeout: 5000 });

  // For long or multiline messages, use load-buffer + paste-buffer
  if (message.includes("\n") || message.length > 200) {
    const bufferName = `claw-web-${randomUUID().slice(0, 8)}`;
    const tmpPath = join(tmpdir(), `claw-web-send-${randomUUID()}.txt`);
    writeFileSync(tmpPath, message, { encoding: "utf-8", mode: 0o600 });
    try {
      await execFileAsync("tmux", ["load-buffer", "-b", bufferName, tmpPath], { timeout: 5000 });
      await execFileAsync("tmux", ["paste-buffer", "-b", bufferName, "-t", tmuxName, "-d"], { timeout: 5000 });
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      try {
        await execFileAsync("tmux", ["delete-buffer", "-b", bufferName], { timeout: 5000 });
      } catch { /* buffer may already be deleted by -d flag */ }
    }
  } else {
    // Use -l (literal) so text like "Enter" isn't interpreted as tmux key names
    await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "-l", message], { timeout: 5000 });
  }

  // Small delay to let tmux process the pasted text before pressing Enter
  await new Promise((resolve) => setTimeout(resolve, 300));
  await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "Enter"], { timeout: 5000 });
}

/** POST /api/sessions/:id/send -- Send a message to a session's agent via tmux. */
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
  if (!body || typeof body.message !== "string") {
    return NextResponse.json(
      { error: "message is required and must be a string" },
      { status: 400 },
    );
  }

  const message = body.message.trim();
  if (message.length === 0) {
    return NextResponse.json({ error: "message must not be empty" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `message must be under ${MAX_MESSAGE_LENGTH} characters` },
      { status: 400 },
    );
  }

  const tmuxName = resolveTmuxName(id);
  if (!tmuxName) {
    return NextResponse.json({ error: "Session not found or no tmux session" }, { status: 404 });
  }

  try {
    await sendToTmux(tmuxName, message);
    return NextResponse.json({ ok: true, sessionId: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send message";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
