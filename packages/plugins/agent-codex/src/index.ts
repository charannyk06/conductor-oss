/**
 * agent-codex plugin — OpenAI Codex CLI as the AI coding agent.
 *
 * - processName: "codex"
 * - promptDelivery: "post-launch"
 * - getLaunchCommand: `codex --model <model> --full-auto`
 * - Activity detection from terminal output patterns
 * - isProcessRunning: check tmux pane for codex process
 *
 * Requires the Codex CLI to be installed and available in PATH.
 */

import { shellEscape } from "@conductor-oss/core";
import type {
  Agent,
  AgentSessionInfo,
  AgentLaunchConfig,
  ActivityState,
  ActivityDetection,
  CostEstimate,
  PluginModule,
  ProjectConfig,
  RuntimeHandle,
  Session,
  WorkspaceHooksConfig,
} from "@conductor-oss/core";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { writeFile, mkdir, readFile, readdir, rename, stat, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

/** Resolve the codex binary path. Checks common locations, falls back to PATH. */
function findCodexBin(): string {
  const candidates = [
    process.env["CODEX_BIN"],
    "/opt/homebrew/bin/codex",  // macOS ARM (Homebrew)
    "/usr/local/bin/codex",     // macOS Intel (Homebrew)
    "/usr/bin/codex",           // Linux
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }

  return "codex";
}

const CODEX_BIN = findCodexBin();

/** Resolve the tmux binary path (used for pane inspection). */
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

/** Default ready threshold: 60 seconds */
const DEFAULT_READY_THRESHOLD_MS = 60_000;

/** Shared bin directory for shell wrappers (prepended to PATH) */
const CLAW_BIN_DIR = join(homedir(), ".conductor", "bin");

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "codex",
  slot: "agent" as const,
  description: "Agent plugin: OpenAI Codex CLI",
  version: "0.2.6",
};

// =============================================================================
// Shell Wrappers (automatic metadata updates)
// =============================================================================

/* eslint-disable no-useless-escape */
const METADATA_HELPER = `#!/usr/bin/env bash
# conductor-metadata-helper — shared by gh/git wrappers
# Provides: update_claw_metadata <key> <value>

update_claw_metadata() {
  local key="\$1" value="\$2"
  local data_dir="\${AO_DATA_DIR:-}"
  local session="\${AO_SESSION:-}"

  [[ -z "\$data_dir" || -z "\$session" ]] && return 0

  case "\$session" in
    */* | *..*) return 0 ;;
  esac

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
# conductor gh wrapper — auto-updates session metadata on PR operations

bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_gh="\$(PATH="\$clean_path" command -v gh 2>/dev/null)"

if [[ -z "\$real_gh" ]]; then
  echo "conductor-wrapper: gh not found in PATH" >&2
  exit 127
fi

source "\$bin_dir/conductor-metadata-helper.sh" 2>/dev/null || true

case "\$1/\$2" in
  pr/create|pr/merge)
    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT

    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}

    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      case "\$1/\$2" in
        pr/create)
          pr_url="\$(echo "\$output" | grep -Eo 'https://github\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
          if [[ -n "\$pr_url" ]]; then
            update_claw_metadata pr "\$pr_url"
            update_claw_metadata status pr_open

            # Enrich PR metadata for dashboard/session notes
            pr_title="\$("\$real_gh" pr view "\$pr_url" --json title --jq '.title' 2>/dev/null || true)"
            pr_head="\$("\$real_gh" pr view "\$pr_url" --json headRefName --jq '.headRefName' 2>/dev/null || true)"
            pr_base="\$("\$real_gh" pr view "\$pr_url" --json baseRefName --jq '.baseRefName' 2>/dev/null || true)"
            pr_draft="\$("\$real_gh" pr view "\$pr_url" --json isDraft --jq '.isDraft' 2>/dev/null || true)"

            [[ -n "\$pr_title" ]] && update_claw_metadata prTitle "\$pr_title"
            [[ -n "\$pr_head" ]] && update_claw_metadata prHeadRef "\$pr_head"
            [[ -n "\$pr_base" ]] && update_claw_metadata prBaseRef "\$pr_base"
            if [[ "\$pr_draft" == "true" ]]; then
              update_claw_metadata prDraft "1"
            elif [[ "\$pr_draft" == "false" ]]; then
              update_claw_metadata prDraft "0"
            fi
          fi
          ;;
        pr/merge)
          update_claw_metadata status merged
          ;;
      esac
    fi

    exit \$exit_code
    ;;
  *)
    exec "\$real_gh" "\$@"
    ;;
esac
`;

const GIT_WRAPPER = `#!/usr/bin/env bash
# conductor git wrapper — auto-updates session metadata on branch operations

bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_git="\$(PATH="\$clean_path" command -v git 2>/dev/null)"

if [[ -z "\$real_git" ]]; then
  echo "conductor-wrapper: git not found in PATH" >&2
  exit 127
fi

source "\$bin_dir/conductor-metadata-helper.sh" 2>/dev/null || true

"\$real_git" "\$@"
exit_code=\$?

if [[ \$exit_code -eq 0 ]]; then
  case "\$1/\$2" in
    checkout/-b)
      update_claw_metadata branch "\$3"
      ;;
    switch/-c)
      update_claw_metadata branch "\$3"
      ;;
  esac
fi

exit \$exit_code
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

async function setupCodexWorkspace(workspacePath: string): Promise<void> {
  await mkdir(CLAW_BIN_DIR, { recursive: true });

  await atomicWriteFile(
    join(CLAW_BIN_DIR, "conductor-metadata-helper.sh"),
    METADATA_HELPER,
    0o755,
  );

  const markerPath = join(CLAW_BIN_DIR, ".conductor-version");
  const currentVersion = "0.1.0";
  let needsUpdate = true;
  try {
    const existing = await readFile(markerPath, "utf-8");
    if (existing.trim() === currentVersion) needsUpdate = false;
  } catch {
    // File doesn't exist
  }

  if (needsUpdate) {
    await atomicWriteFile(join(CLAW_BIN_DIR, "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(CLAW_BIN_DIR, "git"), GIT_WRAPPER, 0o755);
    await atomicWriteFile(markerPath, currentVersion, 0o644);
  }

  // Append conductor section to AGENTS.md
  const agentsMdPath = join(workspacePath, "AGENTS.md");
  let existing = "";
  try {
    existing = await readFile(agentsMdPath, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  if (!existing.includes("Conductor Session")) {
    const section = `
## Conductor Session

You are running inside a Conductor managed workspace.
Session metadata is updated automatically via shell wrappers.
`;
    const content = existing
      ? existing.trimEnd() + "\n" + section
      : section.trimStart();
    await writeFile(agentsMdPath, content, "utf-8");
  }
}

// =============================================================================
// Codex Session JSONL Parsing
// =============================================================================

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const MAX_SESSION_SCAN_DEPTH = 4;

/** Content item inside a response_item payload */
interface CodexContentItem {
  type?: string;
  text?: string;
}

/** Payload wrapper used by Codex >= 0.106.0 JSONL format */
interface CodexPayload {
  id?: string;
  cwd?: string;
  model?: string;
  type?: string;
  role?: string;
  content?: CodexContentItem[] | string;
  info?: {
    total_token_usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

interface CodexJsonlLine {
  type?: string;
  /** v0.39 flat format */
  cwd?: string;
  model?: string;
  threadId?: string;
  content?: string;
  role?: string;
  /** v0.39 flat format */
  msg?: {
    type?: string;
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
  /** v0.106+ nested format — data lives inside payload */
  payload?: CodexPayload;
}

/** Extract cwd from a parsed JSONL line (handles both old and new formats). */
function extractCwd(entry: CodexJsonlLine): string | undefined {
  return entry.cwd ?? entry.payload?.cwd;
}

/** Extract model from a parsed JSONL line (handles both formats). */
function extractModel(entry: CodexJsonlLine): string | undefined {
  return entry.model ?? entry.payload?.model;
}

/** Extract session/thread ID from a parsed JSONL line (handles both formats). */
function extractThreadId(entry: CodexJsonlLine): string | undefined {
  return entry.threadId ?? entry.payload?.id;
}

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
      results.push(fullPath);
    } else {
      try {
        const s = await lstat(fullPath);
        if (s.isDirectory()) {
          const nested = await collectJsonlFiles(fullPath, depth + 1);
          results.push(...nested);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }
  return results;
}

async function sessionFileMatchesCwd(
  filePath: string,
  workspacePath: string,
): Promise<boolean> {
  try {
    const handle = await open(filePath, "r");
    let content: string;
    try {
      // Read first 4KB — enough to find "session_meta" type and "cwd" field.
      // In Codex >= 0.106.0 the session_meta line can be 13KB+ (includes full
      // system prompt), so we use a string-match approach instead of JSON.parse.
      const buffer = Buffer.allocUnsafe(4096);
      const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
      content = buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }

    // Quick check: must contain session_meta type marker
    if (!content.includes('"session_meta"')) return false;

    // Match the cwd value directly in the raw text. This handles both the
    // old flat format ("cwd":"...") and the new payload-wrapped format
    // without needing to parse the full (potentially truncated) JSON line.
    return content.includes(`"cwd":"${workspacePath}"`) ||
           content.includes(`"cwd": "${workspacePath}"`);
  } catch {
    // Unreadable file
  }
  return false;
}

async function findCodexSessionFile(workspacePath: string): Promise<string | null> {
  const jsonlFiles = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  if (jsonlFiles.length === 0) return null;

  let bestMatch: { path: string; mtime: number } | null = null;

  for (const filePath of jsonlFiles) {
    const matches = await sessionFileMatchesCwd(filePath, workspacePath);
    if (matches) {
      try {
        const s = await stat(filePath);
        if (!bestMatch || s.mtimeMs > bestMatch.mtime) {
          bestMatch = { path: filePath, mtime: s.mtimeMs };
        }
      } catch {
        // Skip
      }
    }
  }

  return bestMatch?.path ?? null;
}

interface CodexSessionData {
  model: string | null;
  threadId: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Last assistant message — serves as the session summary */
  lastAssistantMessage: string | null;
}

/** Extract text from a response_item's content (array of items or plain string). */
function extractAssistantText(payload: CodexPayload): string | null {
  const content = payload.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        typeof item === "object" &&
        item !== null &&
        item.type === "output_text" &&
        typeof item.text === "string" &&
        item.text.trim()
      ) {
        return item.text.trim();
      }
    }
  }
  return null;
}

async function streamCodexSessionData(filePath: string): Promise<CodexSessionData | null> {
  try {
    const data: CodexSessionData = {
      model: null,
      threadId: null,
      inputTokens: 0,
      outputTokens: 0,
      lastAssistantMessage: null,
    };
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const entry = parsed as CodexJsonlLine;

        // Model: session_meta.model (v0.39) or turn_context.payload.model (v0.106+)
        if (entry.type === "session_meta") {
          const model = extractModel(entry);
          if (model) data.model = model;
          const tid = extractThreadId(entry);
          if (tid) data.threadId = tid;
        }
        if (entry.type === "turn_context") {
          const model = entry.payload?.model;
          if (typeof model === "string") data.model = model;
        }
        // Thread ID: top-level (v0.39) or payload.id (v0.106+)
        if (typeof entry.threadId === "string" && entry.threadId) {
          data.threadId = entry.threadId;
        }
        // Token counts: msg.input_tokens (v0.39) or payload.info.total_token_usage (v0.106+)
        if (entry.type === "event_msg") {
          if (entry.msg?.type === "token_count") {
            data.inputTokens += entry.msg.input_tokens ?? 0;
            data.outputTokens += entry.msg.output_tokens ?? 0;
          }
          if (entry.payload?.type === "token_count" && entry.payload.info?.total_token_usage) {
            const usage = entry.payload.info.total_token_usage;
            data.inputTokens = usage.input_tokens ?? data.inputTokens;
            data.outputTokens = usage.output_tokens ?? data.outputTokens;
          }
        }
        // Last assistant message — the final one is the completion summary
        if (entry.type === "response_item" && entry.payload?.role === "assistant") {
          const text = extractAssistantText(entry.payload);
          if (text) {
            data.lastAssistantMessage = text;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return data;
  } catch {
    return null;
  }
}

/** Session file path cache to avoid redundant filesystem scans */
const SESSION_FILE_CACHE_TTL_MS = 30_000;
const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();

async function findCodexSessionFileCached(workspacePath: string): Promise<string | null> {
  const cached = sessionFileCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) {
    return cached.path;
  }
  const result = await findCodexSessionFile(workspacePath);
  sessionFileCache.set(workspacePath, { path: result, expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS });
  return result;
}

// =============================================================================
// Terminal Output Detection (tmux fallback)
// =============================================================================

/** Capture the last N lines from a tmux pane */
async function captureTmuxPane(handle: RuntimeHandle, lines = 30): Promise<string | null> {
  if (handle.runtimeName !== "tmux" || !handle.id) return null;
  try {
    const { stdout } = await execFileAsync(
      TMUX_BIN,
      ["capture-pane", "-t", handle.id, "-p", "-l", String(lines)],
      { timeout: 5_000 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/** Classify codex activity from raw terminal output */
function classifyCodexTerminal(termOutput: string): ActivityState {
  if (!termOutput.trim()) return "idle";

  const lines = termOutput.trim().split("\n");
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== "")?.trim() ?? "";

  // Codex interactive prompt uses › (U+203A). Matches:
  //   "›", "› Write tests...", "› 52% left"
  if (/^›/.test(lastNonEmpty)) return "idle";

  // Standard shell prompts (bare >, $, #)
  if (/^[>$#]\s*$/.test(lastNonEmpty)) return "idle";

  // Budget/token display line (e.g., "52% left")
  if (/^\d+%\s+(left|remaining)/i.test(lastNonEmpty)) return "idle";

  // Check last 5 lines for codex prompt (may not be the very last line)
  const tail = lines.slice(-5).join("\n");
  if (/^›/m.test(tail)) return "idle";

  // Approval/permission prompts
  if (/approval required/i.test(tail)) return "waiting_input";
  if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";

  return "active";
}

// =============================================================================
// Agent Implementation
// =============================================================================

function createCodexAgent(): Agent {
  return {
    name: "codex",
    processName: "codex",
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = [CODEX_BIN];

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }
      if (config.reasoningEffort) {
        parts.push("-c", shellEscape(`model_reasoning_effort="${config.reasoningEffort}"`));
      }

      // Permission mode:
      // - skip => --yolo (no sandbox, no approval prompts)
      // - default => --full-auto (sandboxed auto-approvals)
      if (config.permissions === "skip") {
        parts.push("--yolo");
      } else {
        parts.push("--full-auto");
      }

      if (config.systemPromptFile) {
        parts.push("-c", `model_instructions_file=${shellEscape(config.systemPromptFile)}`);
      } else if (config.systemPrompt) {
        parts.push("-c", `developer_instructions=${shellEscape(config.systemPrompt)}`);
      }

      // NOTE: prompt delivered post-launch via runtime.sendMessage()

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;

      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Prepend wrapper directory to PATH for metadata auto-updates
      env["PATH"] = `${CLAW_BIN_DIR}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyCodexTerminal(terminalOutput);
    },

    async getActivityState(session: Session, readyThresholdMs?: number): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      if (!session.runtimeHandle) return { state: "exited", timestamp: new Date() };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: new Date() };

      // --- Primary signal: JSONL session file mtime ---

      const sessionFile = session.workspacePath
        ? await findCodexSessionFileCached(session.workspacePath)
        : null;

      if (!sessionFile) {
        // No session file — fall back to terminal output entirely
        const termOutput = await captureTmuxPane(session.runtimeHandle);
        if (termOutput) {
          const state = classifyCodexTerminal(termOutput);
          // Terminal "idle" (at prompt) means agent finished → "ready"
          return { state: state === "idle" ? "ready" : state, timestamp: new Date() };
        }
        return null;
      }

      try {
        const s = await stat(sessionFile);
        const timestamp = s.mtime;
        const ageMs = Date.now() - s.mtimeMs;

        if (ageMs <= threshold) {
          // File recently modified — agent is actively working
          return { state: "active", timestamp };
        }

        // --- File is stale — cross-check with terminal output ---
        // This prevents false "ready" when codex is running a long build
        // (file stale but terminal shows active output).
        const termOutput = await captureTmuxPane(session.runtimeHandle);
        if (termOutput) {
          const termState = classifyCodexTerminal(termOutput);
          if (termState === "active") {
            // Terminal shows active work despite stale file (long build, etc.)
            return { state: "active", timestamp: new Date() };
          }
          if (termState === "waiting_input") {
            return { state: "waiting_input", timestamp: new Date() };
          }
        }

        // File stale + terminal confirms idle/unreachable → agent is done
        return { state: "ready", timestamp };
      } catch {
        return null;
      }
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(
            TMUX_BIN,
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)codex(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const sessionFile = await findCodexSessionFileCached(session.workspacePath);
      if (!sessionFile) return null;

      const data = await streamCodexSessionData(sessionFile);
      if (!data) return null;

      const agentSessionId = basename(sessionFile, ".jsonl");

      const cost: CostEstimate | undefined =
        data.inputTokens === 0 && data.outputTokens === 0
          ? undefined
          : {
              inputTokens: data.inputTokens,
              outputTokens: data.outputTokens,
              estimatedCostUsd:
                (data.inputTokens / 1_000_000) * 2.5 + (data.outputTokens / 1_000_000) * 10.0,
            };

      const hasSummary = data.lastAssistantMessage !== null;
      const summary = data.lastAssistantMessage
        ?? (data.model ? `Codex session (${data.model})` : null);

      return {
        summary,
        summaryIsFallback: !hasSummary,
        agentSessionId,
        cost,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      const sessionFile = await findCodexSessionFileCached(session.workspacePath);
      if (!sessionFile) return null;

      const data = await streamCodexSessionData(sessionFile);
      if (!data?.threadId) return null;

      const parts: string[] = [CODEX_BIN, "resume"];

      if (project.agentConfig?.permissions === "skip") {
        parts.push("--yolo");
      } else {
        parts.push("--full-auto");
      }

      if (project.agentConfig?.model) {
        parts.push("--model", shellEscape(project.agentConfig.model as string));
      } else if (data.model) {
        parts.push("--model", shellEscape(data.model));
      }
      const reasoningEffort = session.metadata["reasoningEffort"] ?? project.agentConfig?.reasoningEffort;
      if (reasoningEffort) {
        parts.push("-c", shellEscape(`model_reasoning_effort="${reasoningEffort}"`));
      }

      parts.push(shellEscape(data.threadId));

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, config: WorkspaceHooksConfig): Promise<void> {
      await setupCodexWorkspace(workspacePath);

      // Write MCP config file if servers are provided
      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        const codexDir = join(workspacePath, ".codex");
        await mkdir(codexDir, { recursive: true });
        const mcpConfig = { mcpServers: config.mcpServers };
        await writeFile(join(codexDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf-8");
      }
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupCodexWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCodexAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
