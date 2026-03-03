/**
 * Board Watcher -- watches Obsidian CONDUCTOR.md kanban boards for changes.
 *
 * When a task is moved to "Ready to Dispatch", the watcher:
 *   1. Parses the card text for tags (#agent/codex, #project/my-app, #issue/42)
 *   2. Calls SessionManager.spawn() to create an agent session
 *   3. Moves the card to "Dispatching" with the session ID
 *   4. On session completion, moves to "Done" with PR link
 *
 * Card format:
 *   - [ ] fix the login bug #agent/codex #model/o4-mini #project/my-app #type/bug
 *   - [ ] add dark mode #agent/claude-code #model/claude-opus-4-6
 *   - [ ] implement #42
 *
 * Board columns: Inbox → Ready to Dispatch → Dispatching → In Progress → Review → Done → Blocked
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, readdirSync, mkdirSync, watch as fsWatch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  OrchestratorConfig,
  SessionManager,
  Session,
  PRInfo,
  TaskAttachment,
} from "./types.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoardWatcherConfig {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  boardPaths: string[];
  /** Project ID to board path mapping (derived from board location). */
  boardProjectMap: Map<string, string>;
  /** Polling interval in ms for fswatch fallback. Default: 3000. */
  pollIntervalMs?: number;
  /** Base URL of the dashboard for session links in cards. */
  dashboardUrl?: string;
  /** Obsidian vault / workspace path for session notes. */
  workspacePath?: string;
  onDispatch?: (projectId: string, sessionId: string, task: string) => void;
  onError?: (error: Error, context: string) => void;
}

interface ParsedCard {
  raw: string;
  prompt: string;
  agent: string | undefined;
  model: string | undefined;
  project: string | undefined;
  issueId: string | undefined;
  taskType: string | undefined;
  priority: string | undefined;
  /** Image/file attachments referenced in the card. */
  attachments: TaskAttachment[];
}

// ---------------------------------------------------------------------------
// Card Parsing
// ---------------------------------------------------------------------------

/** Parse tags from card text: #agent/codex, #model/o4-mini, #project/my-app, #issue/42, #type/bug, #priority/high */
function parseTags(text: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const match of text.matchAll(/#([\w-]+)\/([\w.\-]+)/g)) {
    tags[match[1]] = match[2];
  }
  return tags;
}

/** Strip tags and image embeds from card text to get the clean prompt. */
function stripTags(text: string): string {
  return text
    .replace(/#[\w-]+\/[\w.\-]+/g, "")           // #agent/codex etc.
    .replace(/!\[\[([^\]]+)\]\]/g, "")             // ![[image.png]]
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "")      // ![alt](path)
    .replace(/\s+/g, " ")
    .trim();
}

// =============================================================================
// Inbox Task Enhancement (smart auto-tagging)
// =============================================================================

interface InboxEntry {
  /** Raw block text as it appears in the Inbox section (may be multiline). */
  block: string;
  /** Normalized task text without checkbox prefix. */
  text: string;
}

/** Parse Inbox entries. Supports checkbox cards and plain text lines. */
function getInboxEntries(content: string): InboxEntry[] {
  const sectionPattern = new RegExp(`## (Inbox|Backlog)\n(.*?)(?=\n## |\n%%|$)`, "gs");
  const sections = [...content.matchAll(sectionPattern)];
  if (sections.length === 0) return [];

  const entries: InboxEntry[] = [];

  for (const section of sections) {
    const lines = (section[2] ?? "").split("\n");

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] ?? "";
      if (!rawLine.trim()) continue;

      let line = rawLine;
      // Allow quoted task lines (common when typing below a quoted hint block),
      // but skip known instructional quote text.
      if (rawLine.trimStart().startsWith(">")) {
        const unquoted = rawLine.trimStart().replace(/^>\s?/, "");
        const lower = unquoted.trim().toLowerCase();
        const isInstruction =
          lower.startsWith("drop rough ideas")
          || lower.startsWith("move tagged tasks")
          || lower.startsWith("agent finished")
          || lower.startsWith("tags:");
        if (isInstruction || !unquoted.trim()) continue;
        line = unquoted;
      }

      const checkboxMatch = line.match(/^\s*-\s\[\s\]\s+(.+)$/);
      if (checkboxMatch) {
        const blockLines = [rawLine];
        let text = checkboxMatch[1] ?? "";
        while (
          i + 1 < lines.length
          && /^[\t ]/.test(lines[i + 1] ?? "")
          && !(lines[i + 1] ?? "").trimStart().startsWith("- ")
        ) {
          i++;
          const contRaw = lines[i] ?? "";
          const cont = contRaw.trimStart().replace(/^>\s?/, "").trim();
          blockLines.push(contRaw);
          if (cont) text += ` ${cont}`;
        }
        entries.push({ block: blockLines.join("\n"), text: text.replace(/\s+/g, " ").trim() });
        continue;
      }

      if (!line.trimStart().startsWith("## ") && !line.trimStart().startsWith("%%") && !line.trimStart().startsWith("```")) {
        const blockLines = [rawLine];
        let text = line.trim();
        while (
          i + 1 < lines.length
          && /^[\t ]/.test(lines[i + 1] ?? "")
          && !(lines[i + 1] ?? "").trimStart().startsWith("- ")
        ) {
          i++;
          const contRaw = lines[i] ?? "";
          const cont = contRaw.trimStart().replace(/^>\s?/, "").trim();
          blockLines.push(contRaw);
          if (cont) text += ` ${cont}`;
        }
        if (text) entries.push({ block: blockLines.join("\n"), text: text.replace(/\s+/g, " ").trim() });
      }
    }
  }

  return entries;
}

/** Check if a task already has required orchestration tags. */
function hasProperTags(taskText: string): boolean {
  return /#agent\//.test(taskText) && /#project\//.test(taskText);
}

/** Infer project from text keywords + board context. */
function inferProject(text: string, boardProjectId: string | undefined, boardProjects: string[]): string {
  const tagged = parseTags(text)["project"];
  if (tagged) return tagged;
  if (boardProjectId) return boardProjectId;
  if (boardProjects.length === 1) return boardProjects[0] ?? "my-app";

  // When multiple projects share a board, match keywords in the task text
  // against project IDs. Split each projectId on hyphens and check for matches.
  const lower = text.toLowerCase();
  let bestMatch: string | undefined;
  let bestScore = 0;
  for (const projectId of boardProjects) {
    const parts = projectId.toLowerCase().split("-");
    let score = 0;
    for (const part of parts) {
      if (part.length >= 3 && lower.includes(part)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = projectId;
    }
  }
  if (bestMatch && bestScore > 0) return bestMatch;
  return boardProjects[0] ?? "my-app";
}

function inferAgent(text: string): string {
  const tagged = parseTags(text)["agent"];
  if (tagged) return normalizeAgent(tagged);
  const lower = text.toLowerCase();
  const claudeKeywords = ["architecture", "refactor", "design", "figma", "complex", "plan", "review"];
  if (claudeKeywords.some((k) => lower.includes(k))) return "claude-code";
  const geminiKeywords = ["gemini", "google", "vertex"];
  if (geminiKeywords.some((k) => lower.includes(k))) return "gemini";
  return "codex";
}

function inferType(text: string): string {
  const tagged = parseTags(text)["type"];
  if (tagged) return tagged;
  const lower = text.toLowerCase();
  if (lower.includes("review")) return "review";
  if (lower.includes("bug") || lower.includes("broken") || lower.includes("fix")) return "bug";
  if (lower.includes("test") || lower.includes("qa")) return "test";
  if (lower.includes("refactor")) return "refactor";
  return "feature";
}

function inferPriority(text: string): string {
  const tagged = parseTags(text)["priority"];
  if (tagged) return tagged;
  const lower = text.toLowerCase();
  if (/(urgent|critical|asap|broken|login|auth)/.test(lower)) return "high";
  if (/(minor|nice to have|later)/.test(lower)) return "low";
  return "medium";
}

/** Heuristic task enhancement: formats with checkbox + tags. Never splits tasks. */
function enhanceTaskHeuristically(
  rawTask: string,
  boardProjectId: string | undefined,
  boardProjects: string[],
): string | null {
  const normalized = stripTags(rawTask).replace(/^\s*[\-*•]\s*/, "").replace(/^\s*\[\s?\]\s*/, "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  if (hasProperTags(rawTask)) {
    // Already tagged — only reformat if not a proper checklist item
    if (rawTask.startsWith("- [ ] ")) return null; // no change needed
    return `- [ ] ${normalized} ${rawTask.match(/#[\w-]+\/[\w.\-]+/g)?.join(" ") ?? ""}`.trim();
  }

  const project = inferProject(rawTask, boardProjectId, boardProjects);
  const agent = inferAgent(rawTask);
  const type = inferType(rawTask);
  const priority = inferPriority(rawTask);

  return `- [ ] ${normalized} #agent/${agent} #project/${project} #type/${type} #priority/${priority}`;
}

/** Enhance rough Inbox tasks in-place. Never moves columns — user reviews then moves to Ready to Dispatch. */
/**
 * Content-aware write guard (module scope — shared by boardWatcher).
 * After writing a board file, stores content + timestamp. Any external write
 * (Obsidian Kanban plugin) within the guard window gets overwritten with ours.
 */
const writeGuard = new Map<string, { content: string; at: number }>();
const WRITE_GUARD_MS = 15_000;
/** Nudge Obsidian to reload a file after external write. */
function nudgeObsidian(boardPath: string): void {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  try {
    let vaultRoot = dirname(boardPath);
    for (let i = 0; i < 5; i++) {
      if (existsSync(join(vaultRoot, ".obsidian"))) break;
      vaultRoot = dirname(vaultRoot);
    }
    const vaultName = basename(vaultRoot);
    const relPath = boardPath
      .substring(boardPath.indexOf(vaultName + "/") + vaultName.length + 1)
      .replace(/\.md$/, "");
    const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relPath)}`;
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execSync(`${cmd} "${uri}"`, { timeout: 3_000, stdio: "ignore" });
  } catch {
    // Non-fatal — Obsidian may not be running
  }
}


async function enhanceInbox(boardPath: string, config: OrchestratorConfig): Promise<void> {
  if (!existsSync(boardPath)) return;
  const content = readFileSync(boardPath, "utf-8");

  // During guard window, ignore only our own just-written content.
  // If user edited the file (content differs), process immediately.
  const guard = writeGuard.get(boardPath);
  if (guard && Date.now() - guard.at < WRITE_GUARD_MS && content === guard.content) {
    return;
  }
  const entries = getInboxEntries(content);
  if (entries.length === 0) return;

  const boardProjectId = projectFromBoardPath(boardPath, config);
  const dirName = basename(dirname(boardPath));
  let boardProjects = Object.entries(config.projects)
    .filter(([key, proj]) => key === dirName || (proj as { boardDir?: string }).boardDir === dirName)
    .map(([key]) => key);

  // Root workspace board isn't tied to a single project directory.
  // Fall back to all configured projects so keyword inference can pick
  // a real project tag instead of defaulting to #project/my-app.
  if (boardProjects.length === 0) {
    boardProjects = Object.keys(config.projects);
  }

  let updatedContent = content;
  let anyChanged = false;

  for (const entry of entries) {
    if (hasProperTags(entry.text)) continue;
    const enhanced = enhanceTaskHeuristically(entry.text, boardProjectId, boardProjects);
    if (!enhanced) continue;
    if (updatedContent.includes(entry.block)) {
      updatedContent = updatedContent.replace(entry.block, enhanced);
      anyChanged = true;
      console.log(`[board-watcher] Inbox enhanced: "${entry.text.substring(0, 60)}"`);
    }
  }

  if (anyChanged) {
    writeFileSync(boardPath, updatedContent, "utf-8");
    writeGuard.set(boardPath, { content: updatedContent, at: Date.now() });
    console.log(`[board-watcher] Inbox enhancement written: ${boardPath}`);

    nudgeObsidian(boardPath);
  }
}

/** Image file extensions for type detection. */
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff",
]);

/** Extract image/file attachment references from card text. */
function extractAttachments(text: string, workspacePath: string): TaskAttachment[] {
  const attachments: TaskAttachment[] = [];
  const seen = new Set<string>();

  // Obsidian wiki-link embeds: ![[image.png]] or ![[folder/mockup.png]]
  for (const match of text.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    const ref = match[0];
    const rawPath = match[1]!;
    const resolved = resolveAttachmentPath(rawPath, workspacePath);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      const ext = rawPath.slice(rawPath.lastIndexOf(".")).toLowerCase();
      attachments.push({ path: resolved, ref, type: IMAGE_EXTENSIONS.has(ext) ? "image" : "file" });
    }
  }

  // Standard markdown embeds: ![alt text](path/to/file.png)
  for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    const ref = match[0];
    const rawPath = match[2]!;
    const resolved = resolveAttachmentPath(rawPath, workspacePath);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      const ext = rawPath.slice(rawPath.lastIndexOf(".")).toLowerCase();
      attachments.push({ path: resolved, ref, type: IMAGE_EXTENSIONS.has(ext) ? "image" : "file" });
    }
  }

  return attachments;
}

/**
 * Resolve an attachment path relative to the workspace.
 * Only allows paths that resolve within the workspace directory (path traversal protection).
 */
function resolveAttachmentPath(rawPath: string, workspacePath: string): string | null {
  if (!rawPath.trim()) return null;

  // Block absolute paths and ~ expansion — only allow workspace-relative paths.
  // This prevents path traversal attacks via cards referencing /etc/passwd, ~/.ssh/id_rsa, etc.
  if (rawPath.startsWith("/") || rawPath.startsWith("~")) {
    return null;
  }

  // Resolve relative to workspace (Obsidian vault)
  const resolved = join(workspacePath, rawPath);

  // Path traversal guard: resolved path must stay within workspace
  const normalizedWorkspace = workspacePath.endsWith("/") ? workspacePath : workspacePath + "/";
  if (!resolved.startsWith(normalizedWorkspace)) {
    return null;
  }

  if (existsSync(resolved)) return resolved;
  // Try attachments subfolder (common Obsidian convention)
  const inAttachments = join(workspacePath, "attachments", rawPath);
  if (inAttachments.startsWith(normalizedWorkspace) && existsSync(inAttachments)) {
    return inAttachments;
  }
  // File doesn't exist yet — still pass the path so the agent gets the reference
  return resolved;
}

/** Detect issue references like #42 or INT-123. */
function detectIssue(text: string): string | undefined {
  // Explicit #issue/ tag takes priority (already parsed)
  // Look for bare #N patterns (but not #agent/... or #project/...)
  const bareIssue = text.match(/(?<!\w)#(\d+)(?!\w)/);
  if (bareIssue) return bareIssue[1];
  // Jira-style: INT-123, PROJ-456
  const jiraMatch = text.match(/\b([A-Z]{2,10}-\d+)\b/);
  if (jiraMatch) return jiraMatch[1];
  return undefined;
}

/** Normalize agent shorthand aliases to canonical plugin names. */
function normalizeAgent(agent: string): string {
  const aliases: Record<string, string> = {
    claude: "claude-code",
    cc: "claude-code",
    cod: "codex",
    gm: "gemini",
    gem: "gemini",
  };
  return aliases[agent] ?? agent;
}

/** Auto-detect agent from task description if no #agent/ tag. */
function autoDetectAgent(prompt: string): string {
  const lower = prompt.toLowerCase();
  const claudeKeywords = ["design", "architect", "plan", "feature", "build new", "refactor", "complex"];
  for (const kw of claudeKeywords) {
    if (lower.includes(kw)) return "claude-code";
  }
  const geminiKeywords = ["gemini", "google", "vertex"];
  for (const kw of geminiKeywords) {
    if (lower.includes(kw)) return "gemini";
  }
  return "codex";
}
/** Parse a kanban card into structured data. */
function parseCard(cardText: string, workspacePath: string): ParsedCard {
  const tags = parseTags(cardText);
  const prompt = stripTags(cardText);
  const issueFromTag = tags["issue"];
  const issueFromText = detectIssue(cardText);
  const attachments = extractAttachments(cardText, workspacePath);

  return {
    raw: cardText,
    prompt,
    agent: tags["agent"],
    model: tags["model"],
    project: tags["project"],
    issueId: issueFromTag ?? issueFromText,
    taskType: tags["type"],
    priority: tags["priority"],
    attachments,
  };
}

// ---------------------------------------------------------------------------
// Board Parsing / Editing
// ---------------------------------------------------------------------------

/** Column names in the kanban board. */
const COLUMNS = [
  "Inbox",
  "Ready to Dispatch",
  "Dispatching",
  "In Progress",
  "Review",
  "Done",
  "Blocked",
];

/** Extract tasks from a specific column. Returns unchecked items only. */
function getColumnTasks(content: string, column: string): string[] {
  const pattern = new RegExp(
    `## ${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n(.*?)(?=\\n## |\\n%%|$)`,
    "s",
  );
  const match = content.match(pattern);
  if (!match) return [];

  const tasks: string[] = [];
  for (const line of match[1].split("\n")) {
    const taskMatch = line.match(/^- \[ \] (.+)$/);
    if (taskMatch) {
      tasks.push(taskMatch[1]);
    }
  }
  return tasks;
}

/** Move a task from one column to another. Updates the card text if needed. */
function moveCard(
  content: string,
  taskText: string,
  fromColumn: string,
  toColumn: string,
  newCardText?: string,
): string {
  const cardLine = `- [ ] ${taskText}`;
  const newLine = newCardText ? `- [x] ${newCardText}` : `- [x] ${taskText}`;

  // Remove from source column
  let updated = content.replace(cardLine + "\n", "");
  // Also try without trailing newline (last item in column)
  if (updated === content) {
    updated = content.replace(cardLine, "");
  }

  // Add to target column header
  const headerPattern = new RegExp(`(## ${toColumn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n)`);
  const headerMatch = updated.match(headerPattern);
  if (headerMatch) {
    updated = updated.replace(headerMatch[1], `${headerMatch[1]}${newLine}\n`);
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Status Display & Card Tracking
// ---------------------------------------------------------------------------

/** Status emoji for kanban card display. */
const STATUS_EMOJI: Record<string, string> = {
  spawning: "🔄",
  working: "🟢",
  pr_open: "🔵",
  ci_failed: "🔴",
  review_pending: "🟡",
  changes_requested: "🟠",
  approved: "✅",
  mergeable: "🟢",
  merged: "✨",
  cleanup: "🧹",
  needs_input: "⏸️",
  stuck: "⚠️",
  errored: "❌",
  killed: "💀",
  done: "✅",
  terminated: "🛑",
};

/** Terminal statuses that get enriched Done card format. */
const DONE_STATUSES: ReadonlySet<string> = new Set([
  "done", "merged", "killed", "terminated", "cleanup", "errored",
]);

/** Format a duration between two dates into a human-readable string. */
function formatDuration(startDate: Date, endDate: Date): string {
  const ms = endDate.getTime() - startDate.getTime();
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

/** Format a cost estimate into a readable string. */
function formatCost(costUsd: number): string {
  if (costUsd <= 0) return "";
  if (costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

/** Map session status to the appropriate board column. */
function statusToColumn(status: string): string {
  switch (status) {
    case "spawning":
      return "Dispatching";
    case "working":
      return "In Progress";
    case "pr_open":
    case "ci_failed":
    case "review_pending":
    case "changes_requested":
    case "approved":
    case "mergeable":
      return "Review";
    case "merged":
    case "done":
    case "cleanup":
    case "killed":
    case "terminated":
      return "Done";
    case "stuck":
    case "errored":
    case "needs_input":
      return "Blocked";
    default:
      return "In Progress";
  }
}

// ---------------------------------------------------------------------------
// Tracked Card Parsing
// ---------------------------------------------------------------------------

interface TrackedCard {
  sessionId: string;
  line: string;
  column: string;
  basePrompt: string;
}

/** Extract session ID from a card line — matches [prefix-slug-N] not followed by ( (excludes markdown links). */
function extractSessionId(line: string): string | null {
  // Matches both old format [pp-3] and new format [pp-netlify-env-3]
  const matches = [...line.matchAll(/\[([a-zA-Z][\w]*(?:-[\w]+)*-\d+)\](?!\()/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]![1]!;
}

/** Extract base prompt from a card line (text before the [sessionId] marker, excluding dynamic suffix). */
function extractBasePrompt(line: string, sessionId: string): string {
  const marker = `[${sessionId}]`;
  const afterCheckbox = line.replace(/^- \[[ x]\] /, "");
  const markerIdx = afterCheckbox.indexOf(marker);
  if (markerIdx === -1) return afterCheckbox.replace(/\s*—\s*.*$/, "").trim();
  return afterCheckbox.slice(0, markerIdx).trim();
}

/** Columns that contain cards to track and update with live session state. */
const TRACKED_COLUMNS = ["Dispatching", "In Progress", "Review", "Blocked", "Done"];

/** Get all cards with [sessionId] markers from tracked columns. */
function getAllTrackedCards(content: string): TrackedCard[] {
  const cards: TrackedCard[] = [];

  for (const column of TRACKED_COLUMNS) {
    const escapedCol = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`## ${escapedCol}\\n(.*?)(?=\\n## |\\n%%|$)`, "gs");
    for (const sectionMatch of content.matchAll(pattern)) {
      for (const line of sectionMatch[1]!.split("\n")) {
        if (!line.startsWith("- [")) continue;
        const sessionId = extractSessionId(line);
        if (!sessionId) continue;
        cards.push({
          sessionId,
          line,
          column,
          basePrompt: extractBasePrompt(line, sessionId),
        });
      }
    }
  }

  return cards;
}

// ---------------------------------------------------------------------------
// Card Formatting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Obsidian Session Notes
// ---------------------------------------------------------------------------

/** Derive display status by combining session status with live activity state. */
function deriveDisplayStatus(session: Session): { display: string; emoji: string } {
  // Activity-based overrides take priority when they conflict with status
  if (session.activity === "waiting_input" || session.activity === "blocked") {
    return { display: "waiting for input", emoji: STATUS_EMOJI["needs_input"] ?? "⏸️" };
  }
  if (session.activity === "exited" && !DONE_STATUSES.has(session.status)) {
    return { display: "exited (crashed?)", emoji: "💀" };
  }
  if (session.activity === "active") {
    return { display: "actively working", emoji: STATUS_EMOJI["working"] ?? "🟢" };
  }
  if (session.activity === "idle" && !DONE_STATUSES.has(session.status)) {
    return { display: "idle", emoji: "💤" };
  }
  // Fall back to session status
  return {
    display: session.status.replace(/_/g, " "),
    emoji: STATUS_EMOJI[session.status] ?? "❓",
  };
}

/** Write/update an Obsidian markdown note for a session with full details. */
function writeSessionNote(
  workspacePath: string,
  sessionId: string,
  session: Session,
  basePrompt: string,
  config: OrchestratorConfig,
): void {
  const sessionsDir = join(workspacePath, "sessions");
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const notePath = join(sessionsDir, `${sessionId}.md`);
  const meta = session.metadata;
  const { display: displayStatus, emoji } = deriveDisplayStatus(session);
  const created = session.createdAt;
  const lastAct = session.lastActivityAt;
  const duration = formatDuration(created, lastAct);
  const agent = meta["agent"] ?? "unknown";
  const project = session.projectId || meta["project"] || "unknown";
  const boardProject = config.projects[project];
  const boardRef = boardProject?.boardDir ?? project;

  let md = `---\nsession: ${sessionId}\nproject: ${project}\nagent: ${agent}\nstatus: ${session.status}\n`;
  if (session.activity) md += `activity: ${session.activity}\n`;
  if (session.branch) md += `branch: ${session.branch}\n`;
  if (session.pr) md += `pr: ${session.pr.number}\n`;
  md += `created: ${created.toISOString()}\nupdated: ${lastAct.toISOString()}\n---\n\n`;

  md += `# ${emoji} ${basePrompt}\n\n`;

  // Overview table
  md += `| Field | Value |\n|-------|-------|\n`;
  md += `| **Session** | \`${sessionId}\` |\n`;
  md += `| **Project** | ${project} |\n`;
  md += `| **Agent** | ${agent} |\n`;
  md += `| **Status** | ${emoji} ${displayStatus} |\n`;
  if (session.activity) md += `| **Activity** | ${session.activity} |\n`;
  md += `| **Created** | ${created.toISOString().replace("T", " ").slice(0, 19)} |\n`;
  md += `| **Last Activity** | ${lastAct.toISOString().replace("T", " ").slice(0, 19)} |\n`;
  md += `| **Duration** | ${duration} |\n`;
  if (session.branch) md += `| **Branch** | \`${session.branch}\` |\n`;
  if (meta["worktree"]) md += `| **Worktree** | \`${meta["worktree"]}\` |\n`;
  md += `\n`;

  // Summary — prefer real agent summary; if fallback/noisy, synthesize from PR state.
  const rawSummary = session.agentInfo?.summary ?? meta["summary"];
  const normalizedSummary = rawSummary?.replace(/\s+/g, " ").trim();
  const isFallback =
    (session.agentInfo?.summaryIsFallback
      ?? /^(Codex|Claude)\s+session\s*\(/i.test(normalizedSummary ?? ""))
    || (normalizedSummary?.startsWith("You are an AI coding agent managed by Conductor") ?? false);

  let summaryToShow: string | null = null;
  if (normalizedSummary && !isFallback) {
    summaryToShow = normalizedSummary;
  } else if (session.pr) {
    const prTitle = session.pr.title || meta["prTitle"] || "";
    const prState = meta["prState"] ?? "open";
    const ciStatus = meta["ciStatus"] ?? "none";
    const reviewDecision = meta["reviewDecision"] ?? "none";
    summaryToShow = `PR #${session.pr.number}${prTitle ? ` — ${prTitle}` : ""}. State: ${prState}. CI: ${ciStatus}. Review: ${reviewDecision}.`;

    if (meta["mergeReadiness"]) {
      try {
        const readiness = JSON.parse(meta["mergeReadiness"]) as { blockers?: string[] };
        if (Array.isArray(readiness.blockers) && readiness.blockers.length > 0) {
          summaryToShow += ` Blockers: ${readiness.blockers.join("; ")}.`;
        }
      } catch {
        // ignore
      }
    }
  }

  if (summaryToShow) {
    md += `## Summary

${summaryToShow}

`;
  }


  // PR details
  if (session.pr) {
    const pr = session.pr;
    md += `## Pull Request\n\n`;
    md += `- **PR**: [#${pr.number} — ${pr.title}](${pr.url})\n`;
    md += `- **Branch**: \`${pr.branch}\` → \`${pr.baseBranch}\`\n`;
    if (pr.isDraft) md += `- **Draft**: yes\n`;

    const ciStatus = meta["ciStatus"] ?? "none";
    const reviewDecision = meta["reviewDecision"] ?? "none";
    const prState = meta["prState"] ?? "open";

    const ciEmoji = ciStatus === "passing" ? "✅" : ciStatus === "failing" ? "❌" : ciStatus === "pending" ? "⏳" : "—";
    const revEmoji = reviewDecision === "approved" ? "✅" : reviewDecision === "changes_requested" ? "🔄" : reviewDecision === "pending" ? "⏳" : "—";

    md += `- **State**: ${prState}\n`;
    md += `- **CI**: ${ciEmoji} ${ciStatus}\n`;
    md += `- **Review**: ${revEmoji} ${reviewDecision}\n`;

    // Merge readiness
    if (meta["mergeReadiness"]) {
      try {
        const readiness = JSON.parse(meta["mergeReadiness"]) as Record<string, unknown>;
        const check = (v: unknown): string => v ? "✅" : "❌";
        md += `\n### Merge Readiness\n\n`;
        md += `- ${check(readiness["mergeable"])} Mergeable\n`;
        md += `- ${check(readiness["ciPassing"])} CI Passing\n`;
        md += `- ${check(readiness["approved"])} Approved\n`;
        md += `- ${check(readiness["noConflicts"])} No Conflicts\n`;
        if (Array.isArray(readiness["blockers"]) && (readiness["blockers"] as string[]).length > 0) {
          md += `\n**Blockers:**\n`;
          for (const b of readiness["blockers"] as string[]) {
            md += `- ${b}\n`;
          }
        }
      } catch { /* ignore */ }
    }

    md += `\n`;
  }

  // Cost
  if (session.agentInfo?.cost || meta["cost"]) {
    md += `## Cost\n\n`;
    if (session.agentInfo?.cost) {
      const c = session.agentInfo.cost;
      md += `| Metric | Value |\n|--------|-------|\n`;
      if (c.inputTokens != null) md += `| Input Tokens | ${c.inputTokens.toLocaleString()} |\n`;
      if (c.outputTokens != null) md += `| Output Tokens | ${c.outputTokens.toLocaleString()} |\n`;
      if (c.estimatedCostUsd != null) md += `| Estimated Cost | $${c.estimatedCostUsd.toFixed(4)} |\n`;
    } else if (meta["cost"]) {
      try {
        const c = JSON.parse(meta["cost"]) as Record<string, number>;
        md += `| Metric | Value |\n|--------|-------|\n`;
        if (c["inputTokens"] != null) md += `| Input Tokens | ${c["inputTokens"].toLocaleString()} |\n`;
        if (c["outputTokens"] != null) md += `| Output Tokens | ${c["outputTokens"].toLocaleString()} |\n`;
        if (c["totalUSD"] != null) md += `| Estimated Cost | $${c["totalUSD"].toFixed(4)} |\n`;
      } catch { /* ignore */ }
    }
    md += `\n`;
  }

  // Links section
  md += `## Links\n\n`;
  if (session.pr) {
    md += `- [Pull Request #${session.pr.number}](${session.pr.url})\n`;
  }
  if (session.issueId) {
    md += `- Issue: ${session.issueId}\n`;
  }
  md += `- [[projects/${boardRef}/CONDUCTOR|Board]]\n`;
  md += `\n`;

  // Raw metadata
  md += `## Metadata\n\n`;
  md += `\`\`\`\n`;
  for (const [k, v] of Object.entries(meta).sort(([a], [b]) => a.localeCompare(b))) {
    if (k === "runtimeHandle") continue;
    md += `${k}=${v}\n`;
  }
  md += `\`\`\`\n`;

  writeFileSync(notePath, md, "utf-8");
}

/** Format a rich card line with live session state. */
function formatRichCardLine(
  basePrompt: string,
  sessionId: string,
  session: Session,
  opts?: { previewUrl?: string | null; dashboardUrl?: string },
): string {
  const { display: displayStatus, emoji } = deriveDisplayStatus(session);
  const agent = session.metadata["agent"] ?? "unknown";
  const isDone = DONE_STATUSES.has(session.status);

  let info = `${emoji} ${displayStatus} · ${agent}`;

  // Obsidian session note link (wiki-link for in-vault navigation)
  info += ` · [[sessions/${sessionId}|Details]]`;

  // Dashboard session link
  if (opts?.dashboardUrl) {
    const sessionUrl = `${opts.dashboardUrl}/sessions/${sessionId}`;
    info += ` · [Terminal](${sessionUrl})`;
  }

  // Duration — show for completed sessions
  if (isDone) {
    const duration = formatDuration(session.createdAt, session.lastActivityAt);
    info += ` · ⏱ ${duration}`;
  }

  // Cost — show for completed sessions
  if (isDone && session.agentInfo?.cost) {
    const cost = formatCost(session.agentInfo.cost.estimatedCostUsd);
    if (cost) info += ` · 💰 ${cost}`;
  }

  // PR link
  if (session.pr) {
    info += ` · [PR #${session.pr.number}](${session.pr.url})`;
  } else if (session.branch && !session.branch.startsWith("session/")) {
    // Skip redundant branch names like "session/pp-2" (same as session ID)
    info += ` · \`${session.branch}\``;
  }

  // CI / Review badges (from persisted metadata)
  const ciStatus = session.metadata["ciStatus"];
  if (ciStatus && ciStatus !== "none") {
    const ciEmoji = ciStatus === "passing" ? "✅" : ciStatus === "failing" ? "❌" : "⏳";
    info += ` · CI: ${ciEmoji}`;
  }
  const reviewDecision = session.metadata["reviewDecision"];
  if (reviewDecision && reviewDecision !== "none") {
    const revEmoji = reviewDecision === "approved" ? "✅" : reviewDecision === "changes_requested" ? "🔄" : "⏳";
    info += ` · Review: ${revEmoji}`;
  }

  // Preview URL
  if (opts?.previewUrl) {
    info += ` · [Preview](${opts.previewUrl})`;
  }

  // Summary — skip if it's just a duplicate of the base prompt
  const summary = session.agentInfo?.summary;
  if (summary) {
    // Card lines in Obsidian must stay single-line; collapse multiline agent summaries.
    const summarySingleLine = summary.replace(/\s+/g, " ").trim();
    // Don't show summary when it's essentially the same as the prompt text
    // (happens when summary falls back to first user message = our prompt)
    const promptNorm = basePrompt.toLowerCase().replace(/\s+/g, " ").trim();
    const summaryNorm = summarySingleLine.toLowerCase();
    const isDuplicate =
      summaryNorm.startsWith(promptNorm) ||
      promptNorm.startsWith(summaryNorm) ||
      (summaryNorm.length > 20 && promptNorm.includes(summaryNorm.slice(0, 40)));

    if (!isDuplicate) {
      const maxLen = isDone ? 120 : 60;
      const showFallback = isDone;
      if (!session.agentInfo?.summaryIsFallback || showFallback) {
        // Collapse newlines/markdown to single line — multi-line content
        // inside a kanban card breaks the Obsidian kanban parser.
        const flat = summary.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
        const snippet = flat.length > maxLen ? flat.slice(0, maxLen - 3) + "..." : flat;
        info += ` · "${snippet}"`;
      }
    }
  }

  return `- [x] ${basePrompt} [${sessionId}] — ${info}`;
}

/** Format a card for sessions that are no longer active (archived/killed). */
function formatCompletedCardLine(basePrompt: string, sessionId: string): string {
  return `- [x] ${basePrompt} [${sessionId}] — ✅ completed`;
}

// ---------------------------------------------------------------------------
// Card Movement (checked items)
// ---------------------------------------------------------------------------

/** Move a checked card between columns, optionally replacing its text. */
function moveCheckedCard(
  content: string,
  oldLine: string,
  fromColumn: string,
  toColumn: string,
  newLine?: string,
): string {
  const replacement = newLine ?? oldLine;

  // Remove from source column
  let updated = content.replace(oldLine + "\n", "");
  if (updated === content) {
    updated = content.replace(oldLine, "");
  }

  // Add to target column header
  const escapedCol = toColumn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`(## ${escapedCol}\\n)`);
  const headerMatch = updated.match(headerPattern);
  if (headerMatch) {
    updated = updated.replace(headerMatch[1]!, `${headerMatch[1]}${replacement}\n`);
  }

  return updated;
}

/** Replace a card line in-place (same column, text change only). */
function replaceCardLine(content: string, oldLine: string, newLine: string): string {
  return content.replace(oldLine, newLine);
}

// ---------------------------------------------------------------------------
// Preview URL Detection (Netlify / Vercel)
// ---------------------------------------------------------------------------

/**
 * Fetch a deployment preview URL for a PR branch.
 * Checks GitHub commit statuses (Netlify) then deployments API (Vercel).
 */
async function fetchPreviewUrl(pr: PRInfo): Promise<string | null> {
  const { owner, repo, branch } = pr;
  if (!owner || !repo || !branch) return null;

  // 1. Try commit statuses — Netlify posts target_url here
  try {
    const { stdout } = await execFileP("gh", [
      "api", `repos/${owner}/${repo}/commits/${branch}/statuses`,
      "--jq", '[.[] | select(.context | test("(?i)netlify|vercel|deploy-preview|preview")) | .target_url][0] // empty',
    ], { timeout: 10_000 });
    const url = stdout.trim();
    if (url) return url;
  } catch { /* fall through */ }

  // 2. Try deployments API — Vercel creates Preview deployments
  try {
    const { stdout } = await execFileP("gh", [
      "api", `repos/${owner}/${repo}/deployments`,
      "--jq", '[.[] | select(.environment | test("(?i)preview")) | .id][0] // empty',
    ], { timeout: 10_000 });
    const deployId = stdout.trim();
    if (deployId) {
      const { stdout: statusOut } = await execFileP("gh", [
        "api", `repos/${owner}/${repo}/deployments/${deployId}/statuses`,
        "--jq", '.[0].environment_url // .[0].target_url // empty',
      ], { timeout: 10_000 });
      const deployUrl = statusOut.trim();
      if (deployUrl) return deployUrl;
    }
  } catch { /* fall through */ }

  return null;
}

// ---------------------------------------------------------------------------
// Dispatch Logic
// ---------------------------------------------------------------------------

/** Generate a hash for dedup tracking. */
function taskHash(text: string): string {
  return createHash("md5").update(text.trim()).digest("hex");
}

/** Derive project ID from a board file path. */
function projectFromBoardPath(
  boardPath: string,
  config: OrchestratorConfig,
): string | undefined {
  // Project-specific boards: <workspace>/projects/<name>/CONDUCTOR.md
  const dir = dirname(boardPath);
  const dirName = basename(dir);

  // Check if dirName matches a single project key in config
  const directMatch = Object.keys(config.projects).filter((k) => k === dirName);
  if (directMatch.length === 1) return directMatch[0];

  // Check boardDir aliases — return undefined if multiple projects share the same board
  const boardDirMatches: string[] = [];
  for (const [key, project] of Object.entries(config.projects)) {
    if (project.boardDir && project.boardDir === dirName) boardDirMatches.push(key);
  }
  if (boardDirMatches.length === 1) return boardDirMatches[0];
  // Multiple projects share this board — caller must infer from task text
  if (boardDirMatches.length > 1) return undefined;

  // Legacy: first single match (shouldn't reach here)
  for (const [key, project] of Object.entries(config.projects)) {
    if (project.boardDir && project.boardDir === dirName) return key;
  }

  // Check if dirName matches a project path basename
  for (const [key, project] of Object.entries(config.projects)) {
    if (basename(project.path) === dirName) return key;
  }

  // Workspace-level board -- requires #project/ tag
  return undefined;
}

// ---------------------------------------------------------------------------
// Board Watcher
// ---------------------------------------------------------------------------

export interface BoardWatcher {
  start(): void;
  stop(): void;
  /** Manually check a specific board file. */
  checkBoard(boardPath: string): Promise<void>;
  /** Trigger immediate board state sync for all boards. Called by lifecycle on status change. */
  updateNow(): void;
}

/**
 * Sync CONDUCTOR-TAGS.md and .vscode/conductor.code-snippets from current config.
 * Called on startup — auto-updates when projects are added to conductor.yaml.
 */
function syncTagsFile(config: OrchestratorConfig): void {
  const workspace = process.env["CONDUCTOR_WORKSPACE"] ?? process.cwd();
  const projectIds = Object.keys(config.projects).sort();
  const agents = ["codex", "claude-code"];
  const projectChoices = projectIds.join(",");

  // Build the markdown tag lines (one tag per project)
  const projectTagSeeds = projectIds.map((id) => "#project/" + id).join(" ");
  const agentTagSeeds = agents.map((a) => "#agent/" + a).join(" ");

  // Build table rows for projects
  const projectTableRows = projectIds.map((id) => {
    const p = config.projects[id] as unknown as Record<string, unknown>;
    const desc = (p["description"] as string | undefined) ?? id;
    return "| `#project/" + id + "` | " + desc + " |";
  }).join("\n");

  const firstProject = projectIds[0] ?? "my-project";
  const secondProject = projectIds[1] ?? "my-project";

  const allTagsFrontmatter = [
    "  - conductor/reference",
    ...projectIds.map((id) => "  - project/" + id),
    ...agents.map((a) => "  - agent/" + a),
    "  - type/feature", "  - type/fix", "  - type/review", "  - type/chore", "  - type/docs",
    "  - priority/high", "  - priority/medium", "  - priority/low",
  ].join("\n");

  const tagsContent = [
    "---",
    "tags:",
    allTagsFrontmatter,
    "---",
    "",
    "# Conductor Tag Reference",
    "",
    "Quick-reference for tagging tasks in any `CONDUCTOR.md` board.",
    "Type `#` in Obsidian for autocomplete. Type `ctask` in VS Code for a full task snippet.",
    "",
    "> Auto-generated by conductor on startup. Add a project to `conductor.yaml` → it appears here automatically.",
    "",
    "---",
    "",
    "## Project Tags",
    "",
    "| Tag | Description |",
    "|-----|-------------|",
    projectTableRows,
    "",
    "---",
    "",
    "## Agent Tags",
    "",
    "| Tag | Uses |",
    "|-----|------|",
    "| `#agent/codex` | Codex CLI — fast, parallel, `--yolo` mode |",
    "| `#agent/claude-code` | Claude Code — deep reasoning, complex tasks |",
    "",
    "---",
    "",
    "## Type Tags",
    "",
    "| Tag | Meaning |",
    "|-----|---------|",
    "| `#type/feature` | New feature or enhancement |",
    "| `#type/fix` | Bug fix |",
    "| `#type/review` | Code review or audit |",
    "| `#type/chore` | Maintenance / deps / config |",
    "| `#type/docs` | Documentation |",
    "",
    "---",
    "",
    "## Priority Tags",
    "",
    "| Tag | Meaning |",
    "|-----|---------|",
    "| `#priority/high` | Ship today |",
    "| `#priority/medium` | This sprint |",
    "| `#priority/low` | Nice to have |",
    "",
    "---",
    "",
    "## Example Task Formats",
    "",
    "```",
    "Fix login button tooltip #project/" + firstProject + " #agent/claude-code #type/fix #priority/high",
    "",
    "Add analytics dashboard #project/" + secondProject + " #agent/codex #type/feature",
    "```",
    "",
    "---",
    "",
    projectTagSeeds,
    agentTagSeeds,
    "#type/feature #type/fix #type/review #type/chore #type/docs",
    "#priority/high #priority/medium #priority/low",
    "",
  ].join("\n");

  const tagsPath = join(workspace, "CONDUCTOR-TAGS.md");
  try {
    writeFileSync(tagsPath, tagsContent, "utf-8");
    console.log("[board-watcher] Tags synced: " + projectIds.length + " projects → CONDUCTOR-TAGS.md");
  } catch {
    // Non-fatal
  }

  // VS Code snippets
  const snippets = {
    "Conductor Project Tag": {
      prefix: "#project",
      body: ["#project/${1|" + projectChoices + "|}"],
      description: "Route task to a Conductor project",
    },
    "Conductor Agent Tag": {
      prefix: "#agent",
      body: ["#agent/${1|" + agents.join(",") + "|}"],
      description: "Assign task to a specific agent",
    },
    "Conductor Type Tag": {
      prefix: "#type",
      body: ["#type/${1|feature,fix,review,chore,docs|}"],
      description: "Set task type",
    },
    "Conductor Priority Tag": {
      prefix: "#priority",
      body: ["#priority/${1|high,medium,low|}"],
      description: "Set task priority",
    },
    "Conductor Full Task": {
      prefix: "ctask",
      body: [
        "- [ ] ${1:Task description} #project/${2|" + projectChoices + "|} #agent/${3|" + agents.join(",") + "|} #type/${4|feature,fix,review,chore|} #priority/${5|high,medium,low|}",
      ],
      description: "Full Conductor task with all tags",
    },
  };

  const vscodeDir = join(workspace, ".vscode");
  try {
    mkdirSync(vscodeDir, { recursive: true });
    writeFileSync(join(vscodeDir, "conductor.code-snippets"), JSON.stringify(snippets, null, 2), "utf-8");
  } catch {
    // Non-fatal
  }
}


export function createBoardWatcher(watcherConfig: BoardWatcherConfig): BoardWatcher {
  const { config, sessionManager, boardPaths, onDispatch, onError } = watcherConfig;
  const dashboardUrl = watcherConfig.dashboardUrl ?? config.dashboardUrl;
  const workspacePath = watcherConfig.workspacePath
    ?? process.env["CONDUCTOR_WORKSPACE"]
    ?? `${process.env["HOME"]}/.conductor/workspace`;
  const dispatchLogPath = join(workspacePath, "orchestrator", ".dispatched_tasks_v2");
  if (!existsSync(dirname(dispatchLogPath))) {
    mkdirSync(dirname(dispatchLogPath), { recursive: true });
  }
  const dispatched = new Set<string>(
    existsSync(dispatchLogPath)
      ? readFileSync(dispatchLogPath, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [],
  );
  const watchers: ReturnType<typeof fsWatch>[] = [];
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /** Lock to prevent concurrent dispatch on the same board. */
  const boardLocks = new Map<string, Promise<void>>();

  /** Cache for deployment preview URLs — avoids hammering GitHub API every 15s. */
  const previewUrlCache = new Map<string, { url: string | null; checkedAt: number }>();

  /** Re-check interval for missing preview URLs (2 minutes). */
  const PREVIEW_RECHECK_MS = 120_000;

  /** Max cache entries before evicting oldest. */
  const MAX_PREVIEW_CACHE = 200;
  const MAX_DISPATCHED = 5000;

  function log(msg: string): void {
    console.log(`[board-watcher] ${msg}`);
  }

  function logError(err: Error, context: string): void {
    console.error(`[board-watcher] ${context}: ${err.message}`);
    onError?.(err, context);
  }

  async function dispatchTask(
    boardPath: string,
    card: ParsedCard,
    boardProjectId: string | undefined,
  ): Promise<{ sessionId: string } | null> {
    // Determine project — prefer explicit tag, fall back to board path inference
    const projectId = card.project ?? boardProjectId;
    if (!projectId) {
      log(`Skipping task (no project): "${card.prompt}"`);
      return null;
    }

    if (!config.projects[projectId]) {
      log(`Unknown project "${projectId}" in task: "${card.prompt}"`);
      return null;
    }

    // Determine agent (normalize aliases: #agent/claude -> claude-code)
    const agent = normalizeAgent(card.agent ?? autoDetectAgent(card.prompt));

    // Build the prompt/issue
    const issueOrPrompt = card.issueId ?? card.prompt;

    if (card.attachments.length > 0) {
      log(`  Attachments: ${card.attachments.map((a) => `${a.type}:${basename(a.path)}`).join(", ")}`);
    }
    log(`Dispatching [${agent}${card.model ? ` model=${card.model}` : ""}] -> ${projectId}: "${card.prompt}"`);

    try {
      const session: Session = await sessionManager.spawn({
        projectId,
        issueId: card.issueId,
        prompt: card.prompt || undefined,
        agent,
        model: card.model,
        attachments: card.attachments.length > 0 ? card.attachments : undefined,
      });

      log(`Spawned session ${session.id} for "${card.prompt}"`);
      onDispatch?.(projectId, session.id, card.prompt);
      return { sessionId: session.id };
    } catch (err) {
      logError(err instanceof Error ? err : new Error(String(err)), `spawn for "${card.prompt}"`);
      return null;
    }
  }

  async function checkBoard(boardPath: string): Promise<void> {
    if (!existsSync(boardPath)) return;

    const preContent = readFileSync(boardPath, "utf-8");
    const guardCheck = writeGuard.get(boardPath);
    if (guardCheck && Date.now() - guardCheck.at < WRITE_GUARD_MS && preContent === guardCheck.content) {
      return; // Ignore only our own just-written content during cooldown
    }

    // Serialize: if a check is already running for this board, wait for it then skip
    const existing = boardLocks.get(boardPath);
    if (existing) { await existing; return; }

    let resolve!: () => void;
    const lock = new Promise<void>((res) => { resolve = res; });
    boardLocks.set(boardPath, lock);

    try {
      const content = readFileSync(boardPath, "utf-8");
      const tasks = getColumnTasks(content, "Ready to Dispatch");
      if (tasks.length === 0) return;

      const boardProjectId = projectFromBoardPath(boardPath, config);
      let updatedContent = content;
      let anyDispatched = false;

      for (const taskText of tasks) {
        const card = parseCard(taskText, workspacePath);
        const promptHash = taskHash(card.prompt);
        if (dispatched.has(promptHash)) continue;

        // Restart-safe dedupe: if a tracked card with the same base prompt
        // already exists (Dispatching/In Progress/Review/Done/Blocked), skip.
        const existingTracked = getAllTrackedCards(updatedContent).some(
          (tracked) => tracked.basePrompt === card.prompt,
        );
        if (existingTracked) {
          dispatched.add(promptHash);
          continue;
        }

        // Mark as dispatched immediately to prevent re-entry
        dispatched.add(promptHash);

        const result = await dispatchTask(boardPath, card, boardProjectId);

        if (result) {
          // Persist hash to survive process restarts / external board rewrites.
          try {
            appendFileSync(dispatchLogPath, `${promptHash}\n`, "utf-8");
          } catch {
            // Non-fatal
          }
          // Move card: Ready to Dispatch -> Dispatching (with session ID)
          const newCardText = `${card.prompt} [${result.sessionId}]`;
          updatedContent = moveCard(updatedContent, taskText, "Ready to Dispatch", "Dispatching", newCardText);
          anyDispatched = true;
        } else {
          // Failed to dispatch -- remove from dispatched set so it retries
          dispatched.delete(promptHash);
        }
      }

      if (anyDispatched && updatedContent !== content) {
        writeFileSync(boardPath, updatedContent, "utf-8");
        writeGuard.set(boardPath, { content: updatedContent, at: Date.now() });
        log(`Board updated: ${boardPath}`);
        nudgeObsidian(boardPath);
      }

      // Cap dispatched set size to prevent unbounded memory growth
      if (dispatched.size > MAX_DISPATCHED) {
        const excess = dispatched.size - MAX_DISPATCHED;
        let removed = 0;
        for (const hash of dispatched) {
          if (removed >= excess) break;
          dispatched.delete(hash);
          removed++;
        }
      }
    } catch (err) {
      logError(err instanceof Error ? err : new Error(String(err)), `checkBoard ${boardPath}`);
    } finally {
      boardLocks.delete(boardPath);
      resolve();
    }
  }

  /** Periodically update tracked cards with live session state and move between columns. */
  async function updateBoardState(boardPath: string): Promise<void> {
    if (!existsSync(boardPath)) return;
    const existingState = boardLocks.get(boardPath);
    if (existingState) { await existingState; return; }

    let resolveState!: () => void;
    const stateLock = new Promise<void>((res) => { resolveState = res; });
    boardLocks.set(boardPath, stateLock);

    try {
      let content = readFileSync(boardPath, "utf-8");

      // During guard window, ignore only our own just-written content.
      const guard = writeGuard.get(boardPath);
      if (guard && Date.now() - guard.at < WRITE_GUARD_MS && content === guard.content) {
        return;
      }
      const trackedCards = getAllTrackedCards(content);
      if (trackedCards.length === 0) return;

      // Fetch all active sessions in one call
      let sessions: Session[];
      try {
        sessions = await sessionManager.list();
      } catch (err) {
        logError(
          err instanceof Error ? err : new Error(String(err)),
          "updateBoardState list()",
        );
        return;
      }
      const sessionMap = new Map(sessions.map((s) => [s.id, s]));

      // Fetch preview URLs for sessions with PRs (cached, rate-limited)
      const previewUrls = new Map<string, string | null>();
      for (const card of trackedCards) {
        const session = sessionMap.get(card.sessionId);
        if (!session?.pr) continue;

        const cacheKey = card.sessionId;
        const cached = previewUrlCache.get(cacheKey);
        if (cached) {
          if (cached.url) {
            previewUrls.set(card.sessionId, cached.url);
          } else if (Date.now() - cached.checkedAt < PREVIEW_RECHECK_MS) {
            // Not found recently — skip re-fetch
            continue;
          }
        }

        if (!previewUrls.has(card.sessionId)) {
          try {
            const url = await fetchPreviewUrl(session.pr);
            previewUrlCache.set(cacheKey, { url, checkedAt: Date.now() });
            if (url) {
              previewUrls.set(card.sessionId, url);
              log(`Preview URL for [${card.sessionId}]: ${url}`);
            }
          } catch {
            previewUrlCache.set(cacheKey, { url: null, checkedAt: Date.now() });
          }
        }
      }

      // Evict stale preview cache entries (older than 10 min) to bound memory
      const now = Date.now();
      if (previewUrlCache.size > MAX_PREVIEW_CACHE) {
        const staleThreshold = now - 600_000;
        for (const [key, entry] of previewUrlCache) {
          if (entry.checkedAt < staleThreshold) previewUrlCache.delete(key);
        }
      }

      let updated = content;
      let changed = false;

      for (const card of trackedCards) {
        const session = sessionMap.get(card.sessionId);

        if (!session) {
          // Session no longer active (archived/killed). Normalize to a stable
          // completed card line so stale "actively working" text does not linger.
          const completedLine = formatCompletedCardLine(card.basePrompt, card.sessionId);
          if (card.column !== "Done") {
            updated = moveCheckedCard(updated, card.line, card.column, "Done", completedLine);
            changed = true;
            log(`Card [${card.sessionId}] ${card.column} → Done (session archived)`);
          } else if (card.line !== completedLine) {
            updated = replaceCardLine(updated, card.line, completedLine);
            changed = true;
          }
          // Allow re-dispatch if user moves card back to Ready to Dispatch
          dispatched.delete(taskHash(card.basePrompt));
          continue;
        }

        // Write/update Obsidian session note with full details
        try {
          writeSessionNote(workspacePath, card.sessionId, session, card.basePrompt, config);
        } catch (err) {
          logError(err instanceof Error ? err : new Error(String(err)), `writeSessionNote ${card.sessionId}`);
        }

        const targetColumn = statusToColumn(session.status);
        const preview = previewUrls.get(card.sessionId) ?? null;
        const newLine = formatRichCardLine(card.basePrompt, card.sessionId, session, {
          previewUrl: preview,
          dashboardUrl,
        });

        if (targetColumn !== card.column) {
          // Move to correct column with updated text
          updated = moveCheckedCard(updated, card.line, card.column, targetColumn, newLine);
          changed = true;
          log(`Card [${card.sessionId}] ${card.column} → ${targetColumn} (${session.status})`);
        } else if (card.line !== newLine) {
          // Same column — update card text in place.
          // Skip churn for terminal sessions (done/merged/etc.) to avoid
          // rewriting Obsidian files every poll tick due drifting timestamps.
          if (!DONE_STATUSES.has(session.status)) {
            updated = replaceCardLine(updated, card.line, newLine);
            changed = true;
          }
        }
      }

      if (changed && updated !== content) {
        writeFileSync(boardPath, updated, "utf-8");
        writeGuard.set(boardPath, { content: updated, at: Date.now() });
        nudgeObsidian(boardPath);
        log(`Board state updated: ${boardPath}`);
      }
    } catch (err) {
      logError(
        err instanceof Error ? err : new Error(String(err)),
        `updateBoardState ${boardPath}`,
      );
    } finally {
      boardLocks.delete(boardPath);
      resolveState();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;

      log(`Watching ${boardPaths.length} board(s)`);
      for (const bp of boardPaths) {
        log(`  - ${bp}`);
      }

      // Use Node.js fs.watch for each board file
      for (const boardPath of boardPaths) {
        if (!existsSync(boardPath)) {
          log(`Board not found (skipping): ${boardPath}`);
          continue;
        }

        try {
          const watcher = fsWatch(boardPath, { persistent: false }, (eventType) => {
            if (eventType === "change") {
              // Debounce: wait 2s for Obsidian to finish its write cycle
              setTimeout(() => {
                void enhanceInbox(boardPath, config);
                void checkBoard(boardPath);
              }, 2000);
            }
          });

          watcher.on("error", (err) => {
            logError(err, `fs.watch ${boardPath}`);
          });

          watchers.push(watcher);
        } catch (err) {
          logError(err instanceof Error ? err : new Error(String(err)), `watch setup ${boardPath}`);
        }
      }

      // Sync tags file on startup (auto-updates CONDUCTOR-TAGS.md + VS Code snippets)
      syncTagsFile(config);

      // Sync tags file on startup (CONDUCTOR-TAGS.md + VS Code snippets)

      // Run initial inbox enhancement 3s after startup
      setTimeout(() => {
        for (const boardPath of boardPaths) {
          void enhanceInbox(boardPath, config);
        }
      }, 3_000);

      // Run initial board check 2s after startup so existing "Ready to Dispatch"
      // tasks are dispatched without waiting for a file change event.
      setTimeout(() => {
        for (const boardPath of boardPaths) {
          void checkBoard(boardPath);
        }
      }, 2000);

      // Fallback poll in case fs.watch misses events (common on macOS + Obsidian).
      // Run continuously so we don't rely on file event timing quirks.
      const pollMs = watcherConfig.pollIntervalMs ?? 2000;

      pollInterval = setInterval(() => {
        for (const boardPath of boardPaths) {
          if (!existsSync(boardPath)) continue;
          void enhanceInbox(boardPath, config);
          void checkBoard(boardPath);
        }
      }, pollMs);

      // Session state update loop — enriches cards with live status
      updateInterval = setInterval(() => {
        for (const boardPath of boardPaths) {
          void updateBoardState(boardPath);
        }
      }, 5_000);

      // Run initial state update after 3s (let first dispatch cycle complete)
      setTimeout(() => {
        for (const boardPath of boardPaths) {
          void updateBoardState(boardPath);
        }
      }, 3_000);
    },

    updateNow(): void {
      for (const boardPath of boardPaths) {
        void updateBoardState(boardPath);
      }
    },

    stop(): void {
      running = false;
      for (const w of watchers) {
        w.close();
      }
      watchers.length = 0;
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }

      // Release cached data
      previewUrlCache.clear();
      boardLocks.clear();
      log("Stopped");
    },

    checkBoard,
  };
}

// ---------------------------------------------------------------------------
// Helpers for discovering boards
// ---------------------------------------------------------------------------

/** Find all CONDUCTOR.md boards in the workspace and configured project paths. */
export function discoverBoards(workspacePath: string, config?: OrchestratorConfig): string[] {
  const boards: string[] = [];
  const seen = new Set<string>();

  const addBoard = (path: string): void => {
    if (!existsSync(path)) return;
    if (seen.has(path)) return;
    seen.add(path);
    boards.push(path);
  };

  const expandHome = (path: string): string => {
    if (path.startsWith("~/")) {
      const home = process.env["HOME"] ?? "";
      return home ? join(home, path.slice(2)) : path;
    }
    return path;
  };

  // Workspace-level board
  addBoard(join(workspacePath, "CONDUCTOR.md"));

  const isKanbanBoardFile = (path: string): boolean => {
    if (!existsSync(path)) return false;
    try {
      const content = readFileSync(path, "utf-8");
      return /kanban-plugin:\s*board/i.test(content);
    } catch {
      return false;
    }
  };

  // Project-level boards under workspace/projects/*/CONDUCTOR.md
  const projectsDir = join(workspacePath, "projects");
  if (existsSync(projectsDir)) {
    try {
      for (const entry of readdirSync(projectsDir)) {
        const full = join(projectsDir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            addBoard(join(full, "CONDUCTOR.md"));
          } else if (stat.isFile() && entry.toLowerCase().endsWith(".md") && isKanbanBoardFile(full)) {
            addBoard(full);
          }
        } catch {
          // Ignore entries that disappear between readdir and stat
        }
      }
    } catch {
      // Can't read projects dir
    }
  }

  // Also watch repo-local boards from configured project.path values.
  // This covers cases where users edit <repo>/CONDUCTOR.md directly.
  if (config) {
    for (const project of Object.values(config.projects)) {
      const projectRoot = expandHome(project.path);
      addBoard(join(projectRoot, "CONDUCTOR.md"));

      // Include additional kanban markdown boards in the project root.
      try {
        for (const entry of readdirSync(projectRoot)) {
          if (!entry.toLowerCase().endsWith(".md")) continue;
          const candidate = join(projectRoot, entry);
          if (isKanbanBoardFile(candidate)) addBoard(candidate);
        }
      } catch {
        // Ignore unreadable project roots
      }
    }
  }

  return boards;
}

/** Build the board-to-project mapping for a config. */
export function buildBoardProjectMap(
  boards: string[],
  config: OrchestratorConfig,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const boardPath of boards) {
    const projectId = projectFromBoardPath(boardPath, config);
    if (projectId) {
      map.set(boardPath, projectId);
    }
  }
  return map;
}
