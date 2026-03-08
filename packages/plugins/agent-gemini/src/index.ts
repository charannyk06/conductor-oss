/**
 * agent-gemini plugin — Google Gemini CLI as the AI coding agent.
 *
 * - processName: "gemini"
 * - promptDelivery: "inline" (prompt passed via --prompt-interactive)
 * - getLaunchCommand: `gemini --prompt-interactive "<prompt>"`
 * - Activity detection from terminal output patterns
 * - isProcessRunning: check tmux pane for gemini process
 *
 * Requires the Gemini CLI to be installed: `npm install -g @google/gemini-cli`
 */

import { shellEscape } from "@conductor-oss/core";
import type {
  Agent,
  AgentSessionInfo,
  AgentLaunchConfig,
  ActivityState,
  ActivityDetection,
  PluginModule,
  ProjectConfig,
  RuntimeHandle,
  Session,
  WorkspaceHooksConfig,
} from "@conductor-oss/core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile, mkdir, readFile, rename, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

// =============================================================================
// Binary Resolution
// =============================================================================

function findGeminiBin(): string {
  const candidates = [
    process.env["GEMINI_BIN"],
    "/opt/homebrew/bin/gemini",
    "/usr/local/bin/gemini",
    "/usr/bin/gemini",
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }
  return "gemini";
}

const GEMINI_BIN = findGeminiBin();

function findTmuxBin(): string {
  const candidates = [
    process.env["TMUX_BIN"],
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
    "/bin/tmux",
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }
  return "tmux";
}

const TMUX_BIN = findTmuxBin();
const DEFAULT_READY_THRESHOLD_MS = 60_000;
const CLAW_BIN_DIR = join(homedir(), ".conductor", "bin");
const GEMINI_HOME_DIR = join(homedir(), ".gemini");
const geminiSessionFileCache = new Map<string, string | null>();

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "gemini",
  slot: "agent" as const,
  description: "Agent plugin: Google Gemini CLI",
  version: "0.2.6",
};

// =============================================================================
// Shell Wrappers
// =============================================================================

/* eslint-disable no-useless-escape */
const METADATA_HELPER = `#!/usr/bin/env bash
update_claw_metadata() {
  local key="\$1" value="\$2"
  local data_dir="\${AO_DATA_DIR:-}" session="\${AO_SESSION:-}"
  [[ -z "\$data_dir" || -z "\$session" ]] && return 0
  case "\$session" in */* | *..*) return 0 ;; esac
  local metadata_file="\$data_dir/\$session"
  [[ -f "\$metadata_file" ]] || return 0
  local temp_file="\${metadata_file}.tmp.\$\$"
  local clean_value="\$(printf '%s' "\$value" | tr -d '\\n')"
  local escaped_value="\$(printf '%s' "\$clean_value" | sed 's/[&|\\\\]/\\\\&/g')"
  if grep -q "^\${key}=" "\$metadata_file" 2>/dev/null; then
    sed "s|^\${key}=.*|\${key}=\${escaped_value}|" "\$metadata_file" > "\$temp_file"
  else
    cp "\$metadata_file" "\$temp_file"
    printf '%s=%s\\n' "\$key" "\$clean_value" >> "\$temp_file"
  fi
  mv "\$temp_file" "\$metadata_file"
}
`;

const GH_WRAPPER = `#!/usr/bin/env bash
bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_gh="\$(PATH="\$clean_path" command -v gh 2>/dev/null)"
[[ -z "\$real_gh" ]] && { echo "conductor-wrapper: gh not found" >&2; exit 127; }
source "\$bin_dir/conductor-metadata-helper.sh" 2>/dev/null || true
case "\$1/\$2" in
  pr/create|pr/merge)
    tmpout="\$(mktemp)"; trap 'rm -f "\$tmpout"' EXIT
    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"; exit_code=\${PIPESTATUS[0]}
    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      case "\$1/\$2" in
        pr/create) pr_url="\$(echo "\$output" | grep -Eo 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
          [[ -n "\$pr_url" ]] && { update_claw_metadata pr "\$pr_url"; update_claw_metadata status pr_open; } ;;
        pr/merge) update_claw_metadata status merged ;;
      esac
    fi; exit \$exit_code ;;
  *) exec "\$real_gh" "\$@" ;;
esac
`;

const GIT_WRAPPER = `#!/usr/bin/env bash
bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_git="\$(PATH="\$clean_path" command -v git 2>/dev/null)"
[[ -z "\$real_git" ]] && { echo "conductor-wrapper: git not found" >&2; exit 127; }
source "\$bin_dir/conductor-metadata-helper.sh" 2>/dev/null || true
"\$real_git" "\$@"; exit_code=\$?
if [[ \$exit_code -eq 0 ]]; then
  case "\$1/\$2" in checkout/-b|switch/-c) update_claw_metadata branch "\$3" ;; esac
fi; exit \$exit_code
`;
/* eslint-enable no-useless-escape */

// =============================================================================
// Workspace Setup
// =============================================================================

async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.tmp.${suffix}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  await rename(tmpPath, filePath);
}

async function setupGeminiWorkspace(workspacePath: string): Promise<void> {
  await mkdir(CLAW_BIN_DIR, { recursive: true });
  await atomicWriteFile(join(CLAW_BIN_DIR, "conductor-metadata-helper.sh"), METADATA_HELPER, 0o755);

  const markerPath = join(CLAW_BIN_DIR, ".conductor-version");
  const currentVersion = "0.1.0";
  let needsUpdate = true;
  try {
    const existing = await readFile(markerPath, "utf-8");
    if (existing.trim() === currentVersion) needsUpdate = false;
  } catch { /* doesn't exist */ }

  if (needsUpdate) {
    await atomicWriteFile(join(CLAW_BIN_DIR, "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(CLAW_BIN_DIR, "git"), GIT_WRAPPER, 0o755);
    await atomicWriteFile(markerPath, currentVersion, 0o644);
  }

  const agentsMdPath = join(workspacePath, "AGENTS.md");
  let existing = "";
  try { existing = await readFile(agentsMdPath, "utf-8"); } catch { /* */ }
  if (!existing.includes("Conductor Session")) {
    const section = "\n## Conductor Session\n\nYou are running inside a Conductor managed workspace.\nSession metadata is updated automatically via shell wrappers.\n";
    await writeFile(agentsMdPath, existing ? existing.trimEnd() + "\n" + section : section.trimStart(), "utf-8");
  }
}

// =============================================================================
// Gemini Session Files
// =============================================================================

interface GeminiProjectsIndex {
  projects?: Record<string, string>;
}

interface GeminiThought {
  subject?: string;
  description?: string;
  timestamp?: string;
}

interface GeminiTokens {
  input?: number;
  output?: number;
}

interface GeminiMessagePart {
  text?: string;
}

interface GeminiChatMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: string | GeminiMessagePart[];
  thoughts?: GeminiThought[];
  tokens?: GeminiTokens;
  model?: string;
}

interface GeminiChatSession {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiChatMessage[];
}

async function readGeminiProjectsIndex(baseDir = GEMINI_HOME_DIR): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(baseDir, "projects.json"), "utf-8");
    const parsed = JSON.parse(content) as GeminiProjectsIndex;
    return Object.fromEntries(
      Object.entries(parsed.projects ?? {}).filter((entry): entry is [string, string] => {
        return typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0;
      }),
    );
  } catch {
    return {};
  }
}

async function resolveGeminiProjectAlias(
  workspacePath: string,
  baseDir = GEMINI_HOME_DIR,
): Promise<string | null> {
  const projects = await readGeminiProjectsIndex(baseDir);
  const alias = projects[workspacePath];
  return typeof alias === "string" && alias.trim().length > 0 ? alias : null;
}

async function findGeminiSessionFile(
  workspacePath: string,
  baseDir = GEMINI_HOME_DIR,
): Promise<string | null> {
  const alias = await resolveGeminiProjectAlias(workspacePath, baseDir);
  if (!alias) return null;

  const chatsDir = join(baseDir, "tmp", alias, "chats");
  let entries: string[];
  try {
    entries = await readdir(chatsDir);
  } catch {
    return null;
  }

  const candidates = entries.filter((entry) => entry.startsWith("session-") && entry.endsWith(".json"));
  if (candidates.length === 0) return null;

  let bestMatch: { path: string; mtimeMs: number } | null = null;
  for (const entry of candidates) {
    const filePath = join(chatsDir, entry);
    try {
      const info = await stat(filePath);
      if (!bestMatch || info.mtimeMs > bestMatch.mtimeMs) {
        bestMatch = { path: filePath, mtimeMs: info.mtimeMs };
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return bestMatch?.path ?? null;
}

async function findGeminiSessionFileCached(workspacePath: string): Promise<string | null> {
  const cached = geminiSessionFileCache.get(workspacePath);
  if (cached) {
    try {
      await stat(cached);
      return cached;
    } catch {
      geminiSessionFileCache.delete(workspacePath);
    }
  }

  const resolved = await findGeminiSessionFile(workspacePath);
  geminiSessionFileCache.set(workspacePath, resolved);
  return resolved;
}

async function readGeminiSessionFile(filePath: string): Promise<GeminiChatSession | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as GeminiChatSession;
  } catch {
    return null;
  }
}

function extractGeminiMessageText(message: GeminiChatMessage | null | undefined): string | null {
  if (!message) return null;
  if (typeof message.content === "string") {
    const normalized = message.content.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (Array.isArray(message.content)) {
    const normalized = message.content
      .map((part) => part?.text?.trim())
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .trim();
    return normalized.length > 0 ? normalized : null;
  }

  return null;
}

function extractGeminiSummary(
  data: GeminiChatSession,
): { summary: string | null; summaryIsFallback: boolean } {
  const messages = Array.isArray(data.messages) ? data.messages : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "gemini") continue;
    const content = extractGeminiMessageText(message);
    if (content) {
      return { summary: content, summaryIsFallback: false };
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const thought = messages[index]?.thoughts?.find((entry) => entry?.description?.trim());
    if (thought?.description) {
      return { summary: thought.description.trim(), summaryIsFallback: true };
    }
  }

  for (const message of messages) {
    if (message?.type !== "user") continue;
    const content = extractGeminiMessageText(message);
    if (content) {
      return { summary: content, summaryIsFallback: true };
    }
  }

  return { summary: null, summaryIsFallback: true };
}

function extractGeminiModel(data: GeminiChatSession): string | null {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.model?.trim();
    if (model) return model;
  }
  return null;
}

function resolveGeminiTimestamp(data: GeminiChatSession, fallback: Date): Date {
  const timestamp = data.lastUpdated ?? data.startTime;
  if (!timestamp) return fallback;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

// =============================================================================
// Terminal Output Detection
// =============================================================================

async function captureTmuxPane(handle: RuntimeHandle, lines = 30): Promise<string | null> {
  if (handle.runtimeName !== "tmux" || !handle.id) return null;
  try {
    const { stdout } = await execFileAsync(TMUX_BIN, ["capture-pane", "-t", handle.id, "-p", "-l", String(lines)], { timeout: 5_000 });
    return stdout;
  } catch { return null; }
}

function classifyGeminiTerminal(termOutput: string): ActivityState {
  if (!termOutput.trim()) return "idle";

  const lines = termOutput.trim().split("\n");
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== "")?.trim() ?? "";

  // Gemini uses ❯ as its interactive prompt
  if (/^[❯>]\s*$/.test(lastNonEmpty)) return "idle";
  if (/^[>$#]\s*$/.test(lastNonEmpty)) return "idle";

  const tail = lines.slice(-5).join("\n");
  if (/^[❯>]\s*$/m.test(tail)) return "idle";

  // Approval prompts (non-yolo mode)
  if (/approve|allow|deny|confirm/i.test(tail)) return "waiting_input";
  if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
  if (/do you want to/i.test(tail)) return "waiting_input";

  if (/^(done|complete|finished|exiting)/im.test(lastNonEmpty)) return "idle";

  return "active";
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createGeminiAgent(): Agent {
  return {
    name: "gemini",
    processName: "gemini",
    promptDelivery: "inline",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = [GEMINI_BIN];

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.permissions === "skip") {
        parts.push("--yolo");
      }

      // Keep Gemini interactive so follow-up turns can reuse the same runtime.
      if (config.prompt) {
        parts.push("--prompt-interactive", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) env["AO_ISSUE_ID"] = config.issueId;
      env["PATH"] = `${CLAW_BIN_DIR}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyGeminiTerminal(terminalOutput);
    },

    async getActivityState(session: Session, readyThresholdMs?: number): Promise<ActivityDetection | null> {
      if (!session.runtimeHandle) return { state: "exited", timestamp: new Date() };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: new Date() };

      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const sessionFile = session.workspacePath
        ? await findGeminiSessionFileCached(session.workspacePath)
        : null;

      if (sessionFile) {
        try {
          const sessionData = await readGeminiSessionFile(sessionFile);
          const stats = await stat(sessionFile);
          const timestamp = resolveGeminiTimestamp(sessionData ?? {}, stats.mtime);
          const ageMs = Date.now() - timestamp.getTime();

          if (ageMs <= threshold) {
            return { state: "active", timestamp };
          }

          const termOutput = await captureTmuxPane(session.runtimeHandle);
          if (termOutput) {
            const state = classifyGeminiTerminal(termOutput);
            if (state === "active" || state === "waiting_input") {
              return { state, timestamp: new Date() };
            }
          }

          return { state: "ready", timestamp };
        } catch {
          // Fall through to terminal heuristics.
        }
      }

      const termOutput = await captureTmuxPane(session.runtimeHandle);
      if (termOutput) {
        const state = classifyGeminiTerminal(termOutput);
        return { state: state === "idle" ? "ready" : state, timestamp: new Date() };
      }
      return null;
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(TMUX_BIN, ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"], { timeout: 30_000 });
          const ttys = ttyOut.trim().split("\n").map((t) => t.trim()).filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], { timeout: 30_000 });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)gemini(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            if (processRe.test(cols.slice(2).join(" "))) return true;
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, 0); return true; }
          catch (err: unknown) {
            if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM") return true;
            return false;
          }
        }
        return false;
      } catch { return false; }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (session.workspacePath) {
        const sessionFile = await findGeminiSessionFileCached(session.workspacePath);
        if (sessionFile) {
          const data = await readGeminiSessionFile(sessionFile);
          if (data) {
            const summary = extractGeminiSummary(data);
            return {
              summary: summary.summary,
              summaryIsFallback: summary.summaryIsFallback,
              agentSessionId: data.sessionId ?? null,
              cost: undefined,
            };
          }
        }
      }

      if (!session.runtimeHandle) return null;
      const termOutput = await captureTmuxPane(session.runtimeHandle, 50);
      if (!termOutput) return null;

      const lines = termOutput.trim().split("\n").filter((l) => l.trim());
      const summary = lines
        .filter((l) => !l.match(/^[❯>$#]\s*$/) && !l.match(/^\s*$/))
        .slice(-3)
        .join(" ")
        .substring(0, 200) || null;

      return { summary, summaryIsFallback: true, agentSessionId: session.id, cost: undefined };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      const sessionFile = await findGeminiSessionFileCached(session.workspacePath);
      if (!sessionFile) return null;

      const data = await readGeminiSessionFile(sessionFile);
      if (!data?.sessionId) return null;

      const parts: string[] = [GEMINI_BIN];
      if (project.agentConfig?.permissions === "skip") {
        parts.push("--yolo");
      }
      const model = session.metadata["model"] || project.agentConfig?.model || extractGeminiModel(data);
      if (model) parts.push("--model", shellEscape(model));
      parts.push("--resume", shellEscape(data.sessionId));
      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, config: WorkspaceHooksConfig): Promise<void> {
      await setupGeminiWorkspace(workspacePath);

      // Write MCP config to .gemini/settings.json if servers are provided
      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        const geminiDir = join(workspacePath, ".gemini");
        await mkdir(geminiDir, { recursive: true });
        const settingsPath = join(geminiDir, "settings.json");
        let existingSettings: Record<string, unknown> = {};
        try {
          const content = await readFile(settingsPath, "utf-8");
          existingSettings = JSON.parse(content) as Record<string, unknown>;
        } catch { /* start fresh if missing or invalid */ }
        existingSettings["mcpServers"] = config.mcpServers;
        await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2), "utf-8");
      }
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupGeminiWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createGeminiAgent();
}

export const __test__ = {
  extractGeminiMessageText,
  extractGeminiSummary,
  findGeminiSessionFile,
  readGeminiProjectsIndex,
  resolveGeminiProjectAlias,
};

export default { manifest, create } satisfies PluginModule<Agent>;
