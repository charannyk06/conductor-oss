/**
 * agent-claude-code plugin — Claude Code CLI as the AI coding agent.
 *
 * - processName: "claude"
 * - promptDelivery: "post-launch" (send prompt after agent starts)
 * - Activity detection via Claude's JSONL files at ~/.claude/projects/
 * - getSessionInfo: extract summary + cost from JSONL tail
 * - getRestoreCommand: `claude --resume <sessionUuid>`
 * - setupWorkspaceHooks: write metadata-updater.sh to .claude/settings.json
 */

import { shellEscape } from "@conductor-oss/core";
import type {
  Agent,
  AgentSessionInfo,
  AgentLaunchConfig,
  ActivityDetection,
  ActivityState,
  CostEstimate,
  PluginModule,
  ProjectConfig,
  RuntimeHandle,
  Session,
  WorkspaceHooksConfig,
} from "@conductor-oss/core";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, open, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Shared bin directory for shell wrappers (prepended to PATH) */
const CLAW_BIN_DIR = join(homedir(), ".conductor", "bin");
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

// =============================================================================
// Metadata Updater Hook Script
// =============================================================================

const METADATA_UPDATER_SCRIPT = `#!/usr/bin/env bash
# Metadata Updater Hook for Conductor
#
# PostToolUse hook that auto-updates session metadata when:
# - gh pr create: extracts PR URL and writes to metadata
# - git checkout -b / git switch -c: extracts branch name
# - gh pr merge: updates status to "merged"

set -euo pipefail

CO_DATA_DIR="\${CO_DATA_DIR:-$HOME/.conductor-sessions}"

input=$(cat)

if command -v jq &>/dev/null; then
  tool_name=$(echo "$input" | jq -r '.tool_name // empty')
  command=$(echo "$input" | jq -r '.tool_input.command // empty')
  output=$(echo "$input" | jq -r '.tool_response // empty')
  exit_code=$(echo "$input" | jq -r '.exit_code // 0')
else
  tool_name=$(echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  output=$(echo "$input" | grep -o '"tool_response"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 || echo "")
  exit_code=$(echo "$input" | grep -o '"exit_code"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "0")
fi

if [[ "$exit_code" -ne 0 ]]; then
  echo '{}'
  exit 0
fi

if [[ "$tool_name" != "Bash" ]]; then
  echo '{}'
  exit 0
fi

if [[ -z "\${CO_SESSION:-}" ]]; then
  echo '{"systemMessage": "CO_SESSION not set, skipping metadata update"}'
  exit 0
fi

metadata_file="$CO_DATA_DIR/$CO_SESSION"

if [[ ! -f "$metadata_file" ]]; then
  echo '{"systemMessage": "Metadata file not found: '"$metadata_file"'"}'
  exit 0
fi

update_metadata_key() {
  local key="$1"
  local value="$2"
  local temp_file="\${metadata_file}.tmp"
  local escaped_value=$(echo "$value" | sed 's/[&|\\/]/\\\\&/g')

  if grep -q "^$key=" "$metadata_file" 2>/dev/null; then
    sed "s|^$key=.*|$key=$escaped_value|" "$metadata_file" > "$temp_file"
  else
    cp "$metadata_file" "$temp_file"
    echo "$key=$value" >> "$temp_file"
  fi

  mv "$temp_file" "$metadata_file"
}

# Detect: gh pr create
if [[ "$command" =~ ^gh[[:space:]]+pr[[:space:]]+create ]]; then
  pr_url=$(echo "$output" | grep -Eo 'https://github[.]com/[^/]+/[^/]+/pull/[0-9]+' | head -1)
  if [[ -n "$pr_url" ]]; then
    update_metadata_key "pr" "$pr_url"
    update_metadata_key "status" "pr_open"

    # Enrich PR metadata for dashboard/session notes
    pr_title=$(gh pr view "$pr_url" --json title --jq '.title' 2>/dev/null || true)
    pr_head=$(gh pr view "$pr_url" --json headRefName --jq '.headRefName' 2>/dev/null || true)
    pr_base=$(gh pr view "$pr_url" --json baseRefName --jq '.baseRefName' 2>/dev/null || true)
    pr_draft=$(gh pr view "$pr_url" --json isDraft --jq '.isDraft' 2>/dev/null || true)

    [[ -n "$pr_title" ]] && update_metadata_key "prTitle" "$pr_title"
    [[ -n "$pr_head" ]] && update_metadata_key "prHeadRef" "$pr_head"
    [[ -n "$pr_base" ]] && update_metadata_key "prBaseRef" "$pr_base"
    if [[ "$pr_draft" == "true" ]]; then
      update_metadata_key "prDraft" "1"
    elif [[ "$pr_draft" == "false" ]]; then
      update_metadata_key "prDraft" "0"
    fi

    echo '{"systemMessage": "Updated metadata: PR created at '"$pr_url"'"}'
    exit 0
  fi
fi

# Detect: git checkout -b <branch> or git switch -c <branch>
if [[ "$command" =~ ^git[[:space:]]+checkout[[:space:]]+-b[[:space:]]+([^[:space:]]+) ]] || \\
   [[ "$command" =~ ^git[[:space:]]+switch[[:space:]]+-c[[:space:]]+([^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"
  if [[ -n "$branch" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: git checkout <branch> (without -b) — only feature branches
if [[ "$command" =~ ^git[[:space:]]+checkout[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]] || \\
   [[ "$command" =~ ^git[[:space:]]+switch[[:space:]]+([^[:space:]-]+[/-][^[:space:]]+) ]]; then
  branch="\${BASH_REMATCH[1]}"
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    update_metadata_key "branch" "$branch"
    echo '{"systemMessage": "Updated metadata: branch = '"$branch"'"}'
    exit 0
  fi
fi

# Detect: gh pr merge
if [[ "$command" =~ ^gh[[:space:]]+pr[[:space:]]+merge ]]; then
  update_metadata_key "status" "merged"
  echo '{"systemMessage": "Updated metadata: status = merged"}'
  exit 0
fi

echo '{}'
exit 0
`;

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "claude-code",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code CLI",
  version: "0.2.5",
};

// =============================================================================
// JSONL Helpers
// =============================================================================

/**
 * Convert a workspace path to Claude's project directory path.
 * Claude stores sessions at ~/.claude/projects/{encoded-path}/
 *
 * The path has its leading / stripped, then all / and . are replaced with -.
 * e.g. /Users/dev/.worktrees/ao -> Users-dev--worktrees-ao
 */
export function toClaudeProjectPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
}

/** Find the most recently modified .jsonl session file in a directory */
async function findLatestSessionFile(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  if (jsonlFiles.length === 0) return null;

  const withStats = await Promise.all(
    jsonlFiles.map(async (f) => {
      const fullPath = join(projectDir, f);
      try {
        const s = await stat(fullPath);
        return { path: fullPath, mtime: s.mtimeMs };
      } catch {
        return { path: fullPath, mtime: 0 };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0]?.path ?? null;
}

interface JsonlLine {
  type?: string;
  summary?: string;
  message?: { content?: string; role?: string };
  costUSD?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * Parse only the last `maxBytes` of a JSONL file.
 * Summaries and recent activity are always near the end, so reading the whole
 * file (which can be 100MB+) is wasteful.
 */
async function parseJsonlFileTail(filePath: string, maxBytes = 131_072): Promise<JsonlLine[]> {
  let content: string;
  let offset: number;
  try {
    const { size = 0 } = await stat(filePath);
    offset = Math.max(0, size - maxBytes);
    if (offset === 0) {
      content = await readFile(filePath, "utf-8");
    } else {
      const handle = await open(filePath, "r");
      try {
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        content = buffer.toString("utf-8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return [];
  }

  const firstNewline = content.indexOf("\n");
  const safeContent =
    offset > 0 && firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  const lines: JsonlLine[] = [];
  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        lines.push(parsed as JsonlLine);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

/**
 * Read the last JSONL entry from a file (type + mtime).
 * Optimized for polling — reads only the tail.
 */
async function readLastJsonlEntry(
  filePath: string,
): Promise<{ lastType: string; modifiedAt: Date } | null> {
  try {
    const s = await stat(filePath);
    const modifiedAt = s.mtime;
    const maxBytes = 8192;
    const offset = Math.max(0, s.size - maxBytes);

    let content: string;
    if (offset === 0) {
      content = await readFile(filePath, "utf-8");
    } else {
      const handle = await open(filePath, "r");
      try {
        const length = s.size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        content = buffer.toString("utf-8");
      } finally {
        await handle.close();
      }
    }

    const lines = content.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]?.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof parsed.type === "string") {
          return { lastType: parsed.type, modifiedAt };
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract auto-generated summary from JSONL (last "summary" type entry) */
function extractSummary(
  lines: JsonlLine[],
): { summary: string; isFallback: boolean } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type === "summary" && line.summary) {
      return { summary: line.summary, isFallback: false };
    }
  }

  // Better fallback: latest assistant/result text first.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const content = line?.message?.content;
    if (typeof content !== "string" || !content.trim()) continue;

    if (line?.type === "assistant" || line?.type === "result") {
      const msg = content.replace(/\s+/g, " ").trim();
      if (msg.length > 0) {
        return {
          summary: msg.length > 200 ? msg.substring(0, 200) + "..." : msg,
          isFallback: true,
        };
      }
    }
  }

  // Last-resort fallback: first user message, but skip Conductor boilerplate.
  for (const line of lines) {
    if (
      line?.type === "user" &&
      line.message?.content &&
      typeof line.message.content === "string"
    ) {
      const msg = line.message.content.replace(/\s+/g, " ").trim();
      if (!msg) continue;
      if (
        msg.startsWith("You are an AI coding agent managed by Conductor") ||
        msg.startsWith("## CRITICAL: Fully Autonomous Operation")
      ) {
        continue;
      }
      return {
        summary: msg.length > 160 ? msg.substring(0, 160) + "..." : msg,
        isFallback: true,
      };
    }
  }
  return null;
}

/** Aggregate cost estimate from JSONL usage events */
function extractCost(lines: JsonlLine[]): CostEstimate | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;

  for (const line of lines) {
    if (typeof line.costUSD === "number") {
      totalCost += line.costUSD;
    } else if (typeof line.estimatedCostUsd === "number") {
      totalCost += line.estimatedCostUsd;
    }

    if (line.usage) {
      inputTokens += line.usage.input_tokens ?? 0;
      inputTokens += line.usage.cache_read_input_tokens ?? 0;
      inputTokens += line.usage.cache_creation_input_tokens ?? 0;
      outputTokens += line.usage.output_tokens ?? 0;
    } else {
      if (typeof line.inputTokens === "number") {
        inputTokens += line.inputTokens;
      }
      if (typeof line.outputTokens === "number") {
        outputTokens += line.outputTokens;
      }
    }
  }

  if (inputTokens === 0 && outputTokens === 0 && totalCost === 0) {
    return undefined;
  }

  // Rough estimate when no direct cost data — Sonnet pricing baseline
  if (totalCost === 0 && (inputTokens > 0 || outputTokens > 0)) {
    totalCost = (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;
  }

  return { inputTokens, outputTokens, estimatedCostUsd: totalCost };
}

// =============================================================================
// Process Detection
// =============================================================================

/**
 * Check if a process named "claude" is running in the given runtime handle's context.
 * Uses ps to find processes by TTY (for tmux) or by PID.
 */
async function findClaudeProcess(handle: RuntimeHandle): Promise<number | null> {
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
      if (ttys.length === 0) return null;

      const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
        timeout: 30_000,
      });
      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      const processRe = /(?:^|\/)claude(?:\s|$)/;
      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) {
          return parseInt(cols[0] ?? "0", 10);
        }
      }
      return null;
    }

    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM") {
          return pid;
        }
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Terminal Output Patterns for detectActivity
// =============================================================================

function classifyTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";

  // Check the last line FIRST — if the prompt is visible, the agent is idle
  if (/^[>$#]\s*$/.test(lastLine)) return "idle";

  // Check the bottom of the buffer for permission prompts
  const tail = lines.slice(-5).join("\n");
  if (/Do you want to proceed\?/i.test(tail)) return "waiting_input";
  if (/\(Y\)es.*\(N\)o/i.test(tail)) return "waiting_input";
  if (/bypass.*permissions/i.test(tail)) return "waiting_input";

  return "active";
}

// =============================================================================
// Hook Setup Helper
// =============================================================================

async function setupHookInWorkspace(workspacePath: string, hookCommand: string): Promise<void> {
  const claudeDir = join(workspacePath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const hookScriptPath = join(claudeDir, "metadata-updater.sh");

  try {
    await mkdir(claudeDir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  await writeFile(hookScriptPath, METADATA_UPDATER_SCRIPT, "utf-8");
  await chmod(hookScriptPath, 0o755);

  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const content = await readFile(settingsPath, "utf-8");
      existingSettings = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Invalid JSON — start fresh
    }
  }

  const hooks = (existingSettings["hooks"] as Record<string, unknown>) ?? {};
  const postToolUse = (hooks["PostToolUse"] as Array<unknown>) ?? [];

  // Check if our hook is already configured
  let hookIndex = -1;
  let hookDefIndex = -1;
  for (let i = 0; i < postToolUse.length; i++) {
    const hook = postToolUse[i];
    if (typeof hook !== "object" || hook === null || Array.isArray(hook)) continue;
    const h = hook as Record<string, unknown>;
    const hooksList = h["hooks"];
    if (!Array.isArray(hooksList)) continue;
    for (let j = 0; j < hooksList.length; j++) {
      const hDef = hooksList[j];
      if (typeof hDef !== "object" || hDef === null || Array.isArray(hDef)) continue;
      const def = hDef as Record<string, unknown>;
      if (typeof def["command"] === "string" && def["command"].includes("metadata-updater.sh")) {
        hookIndex = i;
        hookDefIndex = j;
        break;
      }
    }
    if (hookIndex >= 0) break;
  }

  if (hookIndex === -1) {
    postToolUse.push({
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 5000,
        },
      ],
    });
  } else {
    const hook = postToolUse[hookIndex] as Record<string, unknown>;
    const hooksList = hook["hooks"] as Array<Record<string, unknown>>;
    hooksList[hookDefIndex]["command"] = hookCommand;
  }

  hooks["PostToolUse"] = postToolUse;
  existingSettings["hooks"] = hooks;

  await writeFile(settingsPath, JSON.stringify(existingSettings, null, 2) + "\n", "utf-8");
}

// =============================================================================
// Agent Implementation
// =============================================================================

/**
 * Pre-create .claude directory with minimal settings so Claude Code
 * skips the interactive onboarding wizard in fresh worktrees.
 */
async function ensureClaudeConfig(workspacePath: string): Promise<void> {
  const claudeDir = join(workspacePath, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.local.json");
  try {
    await readFile(settingsPath, "utf-8");
  } catch {
    const settings = JSON.stringify({
      permissions: {
        allow: [
          "Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
          "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)",
        ],
      },
    }, null, 2);
    await writeFile(settingsPath, settings, "utf-8");
  }
}

function createClaudeCodeAgent(): Agent {
  return {
    name: "claude-code",
    processName: "claude",
    promptDelivery: "post-launch",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["claude"];

      if (config.permissions === "skip") {
        parts.push("--dangerously-skip-permissions");
      }

      // Always pass --model; default to opus when not explicitly set
      const model = config.model ?? "claude-sonnet-4-6";
      parts.push("--model", shellEscape(model));

      if (config.systemPromptFile) {
        parts.push("--append-system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        parts.push("--append-system-prompt", shellEscape(config.systemPrompt));
      }

      // MCP config file written by setupWorkspaceHooks before this is called
      if (config.workspacePath && config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        const mcpConfigPath = join(config.workspacePath, ".claude", "mcp.json");
        parts.push("--mcp-config", shellEscape(mcpConfigPath));
      }

      // NOTE: prompt is NOT included here — it's delivered post-launch via
      // runtime.sendMessage() to keep Claude in interactive mode.

      return `unset ANTHROPIC_API_KEY 2>/dev/null; ${parts.join(" ")}`;
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["CLAUDECODE"] = "";
      env["CO_SESSION_ID"] = config.sessionId;

      if (config.issueId) {
        env["CO_ISSUE_ID"] = config.issueId;
      }

      // Forward PATH with wrapper bin dir for git/gh metadata hooks
      env["PATH"] = `${CLAW_BIN_DIR}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;

      // Unset ANTHROPIC_API_KEY so Claude uses OAuth (Max/Pro subscription)
      // instead of the API key (which may have zero credits).
      // Users who want API key auth can set it explicitly in conductor.yaml.
      env["ANTHROPIC_API_KEY"] = "";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await findClaudeProcess(handle);
      return pid !== null;
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      const projectPath = toClaudeProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      const entry = await readLastJsonlEntry(sessionFile);
      if (!entry) return null;

      const ageMs = Date.now() - entry.modifiedAt.getTime();
      const timestamp = entry.modifiedAt;

      switch (entry.lastType) {
        case "user":
        case "tool_use":
        case "progress":
          return { state: ageMs > threshold ? "idle" : "active", timestamp };

        case "summary":
          // Definitive completion — conversation ended, agent produced summary.
          // Always "ready" regardless of age so the lifecycle manager
          // detects completion even if it polls minutes later.
          return { state: "ready", timestamp };

        case "result":
          // Agent finished one turn but conversation is still open.
          // In automated mode this means the agent stopped and is waiting
          // for user input (e.g. asked a question or hit a decision point).
          return { state: "waiting_input", timestamp };

        case "assistant":
        case "system":
          return { state: ageMs > threshold ? "idle" : "active", timestamp };

        case "permission_request":
          return { state: "waiting_input", timestamp };

        case "error":
          return { state: "blocked", timestamp };

        default:
          return { state: ageMs > threshold ? "idle" : "active", timestamp };
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      const projectPath = toClaudeProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      const lines = await parseJsonlFileTail(sessionFile);
      if (lines.length === 0) return null;

      const agentSessionId = basename(sessionFile, ".jsonl");
      const summaryResult = extractSummary(lines);

      return {
        summary: summaryResult?.summary ?? null,
        summaryIsFallback: summaryResult?.isFallback,
        agentSessionId,
        cost: extractCost(lines),
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      const projectPath = toClaudeProjectPath(session.workspacePath);
      const projectDir = join(homedir(), ".claude", "projects", projectPath);

      const sessionFile = await findLatestSessionFile(projectDir);
      if (!sessionFile) return null;

      const sessionUuid = basename(sessionFile, ".jsonl");
      if (!sessionUuid) return null;

      const parts: string[] = ["claude", "--resume", shellEscape(sessionUuid)];

      if (project.agentConfig?.permissions === "skip") {
        parts.push("--dangerously-skip-permissions");
      }

      if (project.agentConfig?.model) {
        parts.push("--model", shellEscape(project.agentConfig.model as string));
      }

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, config: WorkspaceHooksConfig): Promise<void> {
      await ensureClaudeConfig(workspacePath);
      const hookScriptPath = join(workspacePath, ".claude", "metadata-updater.sh");
      await setupHookInWorkspace(workspacePath, hookScriptPath);

      // Write MCP config file if servers are provided
      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        const claudeDir = join(workspacePath, ".claude");
        await mkdir(claudeDir, { recursive: true });
        const mcpConfig = { mcpServers: config.mcpServers };
        await writeFile(join(claudeDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf-8");
      }
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await ensureClaudeConfig(session.workspacePath);
      const hookScriptPath = join(session.workspacePath, ".claude", "metadata-updater.sh");
      await setupHookInWorkspace(session.workspacePath, hookScriptPath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createClaudeCodeAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
